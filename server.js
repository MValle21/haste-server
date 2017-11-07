const http = require('http');
const url = require('url');
const fs = require('fs');

const winston = require('winston');
const connect = require('connect');
const uglify = require('uglify-js');

const connectRoute = require('connect-route');
const st = require('st');

const DocumentHandler = require('./lib/document_handler');
const IrcHandler = require('./lib/irchandler');

// Load the configuration and set some defaults
let config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
config.port = process.env.PORT || config.port || 7777;
config.host = process.env.HOST || config.host || 'localhost';

// Set up the logger
if (config.logging) {
  winston.clear();
  for (let configObj of config.logging) {
    let { type, ...options } = configObj;
    winston.add(winston.transports[type], options);
  }
}

// build the store from the config on-demand - so that we don't load it for statics
if (!config.storage) {
  config.storage = { type: 'redis' };
}
if (!config.storage.type) {
  config.storage.type = 'redis';
}

const Store = require('./lib/document_stores/' + config.storage.type);
const preferredStore = new Store(config.storage);

preferredStore.connect();

// Pick up a key generator
let pwOptions = config.keyGenerator || {};
pwOptions.type = pwOptions.type || 'keygen';
const gen = require('./lib/key_generators/' + pwOptions.type);
const keyGenerator = new gen(pwOptions);

let ircHandler;
if (config.irc) {
  config.irc.log = {
    info: function(){},
    warn: function(line) {
      winston.warn('irc: ' + line);
    },
    error: function(line) {
      winston.error('irc: ' + line);
    }
  };
  ircHandler = new IrcHandler(preferredStore, config.irc);
}

// Configure the document handler
const documentHandler = new DocumentHandler({
  store: preferredStore,
  maxLength: config.maxLength,
  keyLength: config.keyLength,
  keyGenerator: keyGenerator
});

// Compress the static javascript assets
if (config.recompressStaticAssets) {
  let fileNames = fs.readdirSync('./static');
  for (let srcFileName of fileNames) {
    let matches = /^([^.]+)\.js$/.exec(srcFileName);
    if (matches != null) {
      let srcPath = `./static/${srcFileName}`;
      let destPath = `./static/${matches[1]}.min.js`;
      let minified = uglify.minify(fs.readFileSync(srcPath, "utf8"));
      if (minified.error) {
        winston.error("error compressing", srcPath, ":", minified.error);
      } else {
        fs.writeFileSync(destPath, minified.code, 'utf8');
        winston.info('compressed ' + srcPath + ' into ' + destPath);
      }
    }
  }
}

// Send the static documents into the preferred store, skipping expirations
for (let name in config.documents) {
  let path = config.documents[name];

  let storeStaticDoc = () => {
    let data = fs.readFileSync(path, 'utf8');
    if (data) {
      let syntax = '';
      let extIndex = path.lastIndexOf('.');
      if (extIndex > -1 && extIndex < path.length - 1) {
        syntax = path.substring(extIndex + 1);
      }
      let info = {
        name: name,
        key: name,
        size: data.length,
        mimetype: 'text/plain',
        syntax: syntax,
        encoding: 'utf-8',
        time: new Date().getTime()
      };
      documentHandler._setStoreObject(info, data, { isStatic: true })
        .then(() => winston.debug('loaded static document', { name, path }))
        .catch(err => winston.error('failed to store static document', { name, path, err }));
    } else {
      winston.error('failed to load static document', { name, path });
    }
  };

  documentHandler._getStoreObject(name, { isStatic: true })
    .then(storeObj => winston.verbose('not storing static document as it already exists', { name }))
    .catch(err => storeStaticDoc());
}

const staticServe = st({
  path: './static',
  url: '/',
  index: 'index.html',
  passthrough: true
});

const apiServe = connectRoute(router => {
  // add documents
  router.post('/docs', (request, response, next) => {
    winston.debug("POST /docs");
    return documentHandler.handlePost(request, response);
  });
  // get documents
  router.get('/docs/:id', (request, response, next) => {
    let id = request.params.id;
    winston.debug(`GET /docs/${id}`);
    let extPos = id.lastIndexOf('.');
    let isStaticDoc = extPos >= 0 && id.substring(0, extPos) in config.documents;
    return documentHandler.handleGet(request, response, { setExpire: !isStaticDoc });
  });
  // get document metadata
  router.head('/docs/:id', (request, response, next) => {
    winston.debug(`HEAD /docs/${request.params.id}`);
    return documentHandler.handleHead(request, response);
  });
  // get recent documents
  router.get('/recent', (request, response, next) => {
    winston.debug("GET /recent");
    return documentHandler.handleRecent(request, response);
  });
  // get metadata for keys
  router.get('/keys/:keys', (request, response, next) => {
    winston.debug(`GET /keys/${request.params.keys}`);
    return documentHandler.handleKeys(request, response);
  });
  if (ircHandler) {
    // notify IRC of document
    router.get('/irc/privmsg/:chan/:id', (request, response, next) => {
      return ircHandler.handleNotify(request, response);
    });
  }
  // if the previous static-serving module didn't respond to the resource, 
  // forward to next with index.html and the web client application will request the doc based on the url
  router.get('/:id', (request, response, next) => {
    winston.debug(`GET /${request.params.id} - redirecting to /index.html`);
    // redirect to index.html, also clearing the previous 'st' module 'sturl' field generated
    // by the first staticServe module. if sturl isn't cleared out then this new request.url is not
    // looked at again.
    request.url = '/index.html';
    request.sturl = null;
    next();
  });
});

const staticRemains = st({
  path: './static',
  url: '/',
  passthrough: false
});

const app = connect();
app.use(staticServe);
app.use(apiServe);
app.use(staticRemains);
app.listen(config.port, config.host);

winston.info('listening on ' + config.host + ':' + config.port);

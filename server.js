var http = require('http');
var fs = require('fs');

var winston = require('winston');
var connect = require('connect');
var route = require('connect-route');
var connect_st = require('st');
var connect_rate_limit = require('connect-ratelimit');

var DocumentHandler = require('./lib/document_handler');
var IrcHandler = require('./lib/irchandler');

// Load the configuration and set some defaults
var config = JSON.parse(fs.readFileSync('./config.js', 'utf8'));
config.port = process.env.PORT || config.port || 7777;
config.host = process.env.HOST || config.host || 'localhost';

// Set up the logger
if (config.logging) {
  try {
    winston.remove(winston.transports.Console);
  } catch(e) {
    /* was not present */
  }

  var detail, type;
  for (var i = 0; i < config.logging.length; i++) {
    detail = config.logging[i];
    type = detail.type;
    delete detail.type;
    winston.add(winston.transports[type], detail);
  }
}

// build the store from the config on-demand - so that we don't load it for statics
if (!config.storage) {
  config.storage = { type: 'redis' };
}
if (!config.storage.type) {
  config.storage.type = 'redis';
}

var Store = require('./lib/document_stores/' + config.storage.type);
var preferredStore = new Store(config.storage);

// Pick up a key generator
var pwOptions = config.keyGenerator || {};
pwOptions.type = pwOptions.type || 'keygen';
var gen = require('./lib/key_generators/' + pwOptions.type);
var keyGenerator = new gen(pwOptions);

var ircHandler;
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
var documentHandler = new DocumentHandler({
  store: preferredStore,
  maxLength: config.maxLength,
  keyLength: config.keyLength,
  keyGenerator: keyGenerator
});

// Compress the static javascript assets
if (config.recompressStaticAssets) {
  var jsp = require('uglify-js').parser;
  var pro = require('uglify-js').uglify;
  var list = fs.readdirSync('./static');
  for (var j = 0; j < list.length; j++) {
    var item = list[j];
    var orig_code, ast;
    if ((item.indexOf('.js') === item.length - 3) && (item.indexOf('.min.js') === -1)) {
      var dest = item.substring(0, item.length - 3) + '.min' + item.substring(item.length - 3);
      orig_code = fs.readFileSync('./static/' + item, 'utf8');
      ast = jsp.parse(orig_code);
      ast = pro.ast_mangle(ast);
      ast = pro.ast_squeeze(ast);
      fs.writeFileSync('./static/' + dest, pro.gen_code(ast), 'utf8');
      winston.info('compressed ' + item + ' into ' + dest);
    }
  }
}

// Send the static documents into the preferred store, skipping expirations
var path, data;
for (var name in config.documents) {
  path = config.documents[name];

  var storeStaticDoc = function() {
    data = fs.readFileSync(path, 'utf8');
    if (data) {
      var syntax = '';
      var extIndex = path.lastIndexOf('.');
      if (extIndex > -1 && extIndex < path.length - 1) {
        syntax = path.substring(extIndex + 1);
      }
      var doc = {
        name: name,
        size: data.length,
        mimetype: 'text/plain',
        syntax: syntax
      };
      // we're not actually using http requests to initialize the static docs
      // so use a fake response object to determine finished success/failure
      var nonHttpResponse = {
        writeHead: function(code, misc) {
          if (code == 200) {
            winston.debug('loaded static document', { file: name, path: path });
          } else {
            winston.warn('failed to store static document', { file: name, path: path });
          }
        },
        end: function(){}
      };
      documentHandler._setStoreObject(doc, data, nonHttpResponse, true);
    }
    else {
      winston.warn('failed to load static document', { name: name, path: path });
    }
  };

  var nonHttpResponse = {writeHead: function(){},end: function(){}};
  documentHandler._getStoreObject(name, true, nonHttpResponse, function(err, doc) {
    if (err) {
      storeStaticDoc();
    }
    else {
      winston.verbose('not storing static document as it already exists', {name: name});
    }
  });
}

var app = connect();

// Rate limit all requests
if (config.rateLimits) {
  config.rateLimits.end = true;
  app.use(connect_rate_limit(config.rateLimits));
}

// first look at API calls
app.use(route(function(router) {
  // get raw documents - support getting with extension
  router.get('/raw/:id', function(request, response) {
    var key = request.params.id.split('.')[0];
    var skipExpire = !!config.documents[key];
    return documentHandler.handleRawGet(key, response, skipExpire);
  });
  // add documents
  router.post('/docs', function(request, response) {
    return documentHandler.handlePost(request, response);
  });
  // get documents
  router.get('/docs/:id', function(request, response) {
    var key = request.params.id.split('.')[0];
    var skipExpire = !!config.documents[key];
    return documentHandler.handleGet(key, request, response, skipExpire);
  });
  // get document metadata
  router.head('/docs/:id', function(request, response) {
    var key = request.params.id.split('.')[0];
    return documentHandler.handleHead(key, request, response);
  });
  // get recent documents
  router.get('/recent', function(request, response) {
    return documentHandler.handleRecent(request, response);
  });
  // get metadata for keys
  router.get('/keys/:keys', function(request, response) {
    return documentHandler.handleKeys(request, response);
  });
  // notify IRC of document
  router.get('/irc/privmsg/:chan/:id', function(request, response) {
    if (ircHandler) {
      return ircHandler.handleNotify(request, response);
    }
  });
}));

// Otherwise, try to match static files
app.use(connect_st({
  path: __dirname + '/static',
  content: { maxAge: config.staticMaxAge },
  passthrough: true,
  index: false
}));

// Then we can loop back - and everything else should be a token,
// so route it back to /
// if the previous static-serving module didn't respond to the resource, 
// forward to next with index.html and the web client application will request the doc based on the url
app.use(route(function(router) {
  router.get('/:id', function(request, response, next) {
    // redirect to index.html, also clearing the previous 'st' module 'sturl' field generated
    // by the first staticServe module. if sturl isn't cleared out then this new request.url is not
    // looked at again.
    request.url = '/index.html';
    request.sturl = null;
    next();
  });
}));

// And match index
app.use(connect_st({
  path: __dirname + '/static',
  content: { maxAge: config.staticMaxAge },
  index: 'index.html'
}));

http.createServer(app).listen(config.port, config.host);

winston.info('listening on ' + config.host + ':' + config.port);

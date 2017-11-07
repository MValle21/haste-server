const winston = require('winston');
const Busboy = require('busboy');
const zlib = require('zlib');
const mimetypes = require('mime');
const util = require('util');

const gzip = util.promisify(zlib.gzip);
const gunzip = util.promisify(zlib.gunzip);

class DocumentHandler {
  constructor(options = {}) {
    this.keyLength = options.keyLength || DocumentHandler.defaultKeyLength;
    this.maxLength = options.maxLength; // none by default
    this.store = options.store;
    this.keyGenerator = options.keyGenerator;
  }

  /**
   * Stores the metadata and data for a document in the database.
   * 
   * If `forStaticDoc` is true, this will use `info.name`
   * as the key, otherwise a new random key will be generated.
   * 
   * Returns the key that was used to store the document.
   */
  async _setStoreObject(info, rawData, setOptions={}) {
    let zippedData = await gzip(rawData);
    let b64zipped = zippedData.toString('base64');
    if (this.maxLength && b64zipped.length > this.maxLength) {
      throw new Error(`Document exceeds maximum length of ${this.maxLength} bytes (doc size is ${b64zipped.length} bytes after gzip+base64)`);
    }
    info.key = setOptions.isStatic ? info.name : await this.chooseKey();
    await this.store.set(info.key, info, b64zipped, setOptions);
    return info.key;
  }

  /**
   * Returns the document associated with the given key as an object with
   * 2 fields:
   *  * `info`: the metadata about the document
   *  * `data`: the raw string contents of the document (unzipped and decoded)
   */
  async _getStoreObject(key, getOptions) {
    let storeObj = await this.store.get(key, getOptions);
    if (!storeObj.info) {
      throw new Error(`Couldn't find document with key ${key}`);
    }
    winston.verbose('retrieved document', { key: key, info: storeObj.info });
    storeObj.data = await gunzip(new Buffer(storeObj.data, 'base64'));
    return storeObj;
  }
  _respondSuccess(response, data) {
    response.writeHead(200, { 'content-type': 'application/json' });
    if (data) {
      response.end(JSON.stringify(data));
    } else {
      response.end();
    }
  }
  _respondFailure(response, err) {
    winston.error(err);
    let statusCode = err.statusCode || 500;
    response.writeHead(statusCode, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: err.message }));
  }
  handleHead(request, response) {
    let key = request.params.id;
    if (key.lastIndexOf('.') > -1) {
      key = key.substring(0, key.lastIndexOf('.'));
    }
    this.store.getMetadata([key])
      .then(info => {
        let header = this._getDocHeader(info[0], request, response);
        if (header) {
          response.writeHead(200, header);
          response.end();
        }
      }).catch(err => {
        this._respondFailure(response, err);
      });
  }
  // Handle retrieving a document
  handleGet(request, response, getOptions) {
    let key = request.params.id;
    if (key.lastIndexOf('.') > -1) {
      key = key.substring(0, key.lastIndexOf('.'));
    }
    this._getStoreObject(key, getOptions)
      .then(storeObj => {
        storeObj.info.key = key;
        let header = this._getDocHeader(storeObj.info, request, response);
        if (header) {
          let statusCode = 200;
          if (storeObj.info.mimetype == 'url-redirect') {
            try {
              header.location = storeObj.data;
              statusCode = 301;
            } catch (e) { }
          }
          response.writeHead(statusCode, header);
          response.end(storeObj.data.toString('base64'), 'base64');
        }
      }).catch(err => {
        this._respondFailure(response, err);
      });
  }
  _getDocHeader(info, request, response) {
    let ct = request.headers['accept'];
    let mimetype = info.mimetype;
    let urltype = mimetypes.getType(info.key);
    if (urltype && urltype !== 'application/octet-stream') {
      mimetype = urltype;
    }
    let acceptable = [info.mimetype, '$/*', '*/*'];
    let slashindex = info.mimetype.indexOf('/');
    if (slashindex > -1) {
      acceptable[1] = acceptable[1].replace('$', info.mimetype.substring(0, slashindex));
    }
    let allowedByContentType = (!!urltype) || ct == null;
    if (!allowedByContentType) {
      for (let i = 0; i < acceptable.length; i++) {
        if (ct.indexOf(acceptable[i]) > -1) {
          allowedByContentType = true;
          break;
        }
      }
    }
    if (!allowedByContentType) {
      winston.warn('document content type is not allowed per request', { requested: ct, doctype: info.mimetype, urltype: urltype });
      response.writeHead(415, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'Requested document does not support acceptable content-type' }));
      return null;
    }
    return {
      'content-type': mimetype,
      'content-length': info.size,
      'x-haste-key': info.key,
      'x-haste-name': info.name,
      'x-haste-size': info.size,
      'x-haste-syntax': info.syntax,
      'x-haste-mimetype': info.mimetype,
      'x-haste-encoding': info.encoding,
      'x-haste-time': info.time
    };
  }
  // Handle adding a new Document
  handlePost(request, response) {
    let info = {
      name: '',
      size: 0,
      syntax: '',
      mimetype: 'text/plain',
      encoding: 'utf-8',
      time: new Date().getTime()
    };
    // If we should, parse a form to grab the data
    let ct = request.headers['content-type'];
    if (ct && ct.split(';')[0] === 'multipart/form-data') {
      let busboy = new Busboy({ headers: request.headers });
      busboy.on('field', (fieldname, val) => {
        if (fieldname === 'data') {
          info.size = val.length;
          val = this._setUrlRedirectFromPaste(info, val);
          this._setStoreObject(info, val)
            .then(key => this._respondSuccess(response, { key }))
            .catch(err => this._respondFailure(response, err));
        }
      });
      busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
        if (mimetype == 'application/octet-stream') {
          let detectedType = mimetypes.getType(filename);
          if (detectedType) {
            mimetype = detectedType;
          }
        }
        info.name = filename;
        info.mimetype = mimetype;
        info.encoding = encoding;
        let extIndex = filename.lastIndexOf('.');
        if (extIndex > -1 && extIndex < filename.length - 1) {
          info.syntax = filename.substring(extIndex + 1);
        }
        let chunks = [];
        file.on('data', function (chunk) {
          chunks.push(chunk);
        });
        file.on('end', () => {
          let buffer = Buffer.concat(chunks);
          info.size = buffer.length;
          this._setStoreObject(info, buffer)
            .then(key => this._respondSuccess(response, { name: info.name, key: key }))
            .catch(err => this._respondFailure(response, err));
        });
        file.on('error', err => {
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify(err));
        });
      });
      request.pipe(busboy);
      // Otherwise, use our own and just grab flat data from POST body
    } else {
      let cancelled = false;
      let chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        if (!cancelled) {
          let buffer = Buffer.concat(chunks);
          info.size = buffer.length;
          buffer = this._setUrlRedirectFromPaste(info, buffer);
          this._setStoreObject(info, buffer)
            .then(key => this._respondSuccess(response, { key: key }))
            .catch(err => this._respondFailure(response, err));
        }
      });
      request.on('error', err => {
        winston.error('connection error: ' + err.message);
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: 'Connection error.' }));
        cancelled = true;
      });
    }
  }
  _setUrlRedirectFromPaste(info, buffer) {
    try {
      let protocolLen = Math.min(buffer.length, 8);
      let protocol = buffer.toString('utf-8', 0, protocolLen).toLowerCase();
      if (protocol.indexOf('http://') == 0 || protocol.indexOf('https://') == 0) {
        let onlyUrl = buffer.toString('utf-8').replace('\r', '');
        lines = onlyUrl.split('\n');
        if (lines.length == 1) {
          info.mimetype = 'url-redirect';
          return new Buffer(lines[0]);
        }
      }
    } catch (e) { }
    return buffer;
  }
  handleRecent(request, response) {
    this.store.getRecent()
      .then(recentKeys => this._respondSuccess(response, recentKeys))
      .catch(err => this._respondFailure(response, err));
  }
  handleKeys(request, response) {
    let keys = request.params.keys.split(',');
    this.store.getMetadata(keys)
      .then(infos => this._respondSuccess(response, infos))
      .catch(err => this._respondFailure(response, err));
  }

  // Keep choosing keys until one isn't taken
  async chooseKey() {
    let existingData, key;
    do {
      key = this.generateRandomKey();
      existingData = await this.store.get(key);
    } while (existingData.info);
    return key;
  }

  generateRandomKey() {
    return this.keyGenerator.createKey(this.keyLength);
  }
}

DocumentHandler.defaultKeyLength = 10;

module.exports = DocumentHandler;

var winston = require('winston');
var Busboy = require('busboy');
var zlib = require('zlib');
var mimetypes = require('mime');

var DocumentHandler = function(options) {
  if (!options) {
    options = {};
  }
  this.keyLength = options.keyLength || DocumentHandler.defaultKeyLength;
  this.maxLength = options.maxLength; // none by default
  this.store = options.store;
  this.keyGenerator = options.keyGenerator;
};

DocumentHandler.defaultKeyLength = 10;

DocumentHandler.prototype._setStoreObject = function(metadata, rawData, response, forStaticDoc) {
  var _this = this;
  var validateAndStore = function(metadata, b64zipped) {
    // Check length
    if (_this.maxLength && b64zipped.length > _this.maxLength) {
      winston.warn('document > maxLength', { maxLength: _this.maxLength });
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'Document exceeds maximum length.' }));
      return;
    }

    // And then save if we should
    _this.chooseKey(function (key) {
      // static documents are linked via static key/name rather than some generated key
      if (forStaticDoc) {
        key = metadata.name;
      }
      _this.store.set(key, metadata, b64zipped, function (res) {
        if (res) {
          winston.verbose('added document', { key: key });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ key: key, metadata: metadata }));
        } else {
          winston.verbose('error adding document');
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ message: 'Error adding document.' }));
        }
      });
    });
  };

  zlib.gzip(rawData, function(err, zippedData) {
    if (!err) {
      var b64zipped = '';
      try {
        b64zipped = zippedData.toString('base64');
      } catch (error) {
        winston.error('base64 error', { error: error });
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: 'zlib error' }));
        return;
      }
      validateAndStore(metadata, b64zipped);
    } else {
      winston.error('zlib error', { error: err });
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'zlib error' }));
    }
  });
};

DocumentHandler.prototype._getStoreObject = function(key, skipExpire, response, callback) {
  this.store.get(key, function(reply) {
    if (!reply || reply.length != 2) {
      winston.warn('document not found', { key: key, reply: reply });
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'Document not found.' }));
      callback(true);
      return;
    }

    winston.verbose('retrieved document', { key: key });
    var doc = {};
    try {
      doc = JSON.parse(reply[0]);
    } catch (err) {
      winston.error('document metadata not in json format', { key: key, metadata: reply[0] });
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'Error with document' }));
      callback(true);
      return;
    }
    zlib.gunzip(new Buffer(reply[1], 'base64'), function(err, rawData) {
      if (err) {
        winston.error('zlib error', { key: key, error: err });
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: 'Error with document' }));
        callback(true);
        return;
      }
      try {
        doc.file = rawData.toString('base64');
      } catch (err) {
        winston.error('document not in json format', { key: key, error: err });
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: 'Error with document' }));
        callback(true);
        return;
      }
      callback(false, doc);
    });
  }, skipExpire);
};

DocumentHandler.prototype.handleHead = function(key, request, response) {
  var _this = this;
  this.store.getMetadata([key], function(reply) {
    var metadata = reply[0];
    var header = _this._getDocHeader(metadata, request, response);
    if (header) {
      response.writeHead(200, header);
      response.end();
    }
  });
};

// Handle retrieving a document
DocumentHandler.prototype.handleGet = function(key, request, response, skipExpire) {
  var _this = this;
  this._getStoreObject(key, skipExpire, response, function(err, doc) {
    if (err) {
      return;
    }

    doc.key = key;
    var header = _this._getDocHeader(doc, request, response);
    if (header) {
      var statusCode = 200;
      if (doc.mimetype == 'url-redirect') {
        try {
          header.location = new Buffer(doc.file, 'base64').toString();
          statusCode = 301;
        } catch (e) {}
      }
      response.writeHead(statusCode, header);
      response.end(doc.file, 'base64');
    }
  });
};

DocumentHandler.prototype._getDocHeader = function(doc, request, response) {
  var ct = request.headers['accept'];
  var mimetype = doc.mimetype;

  var urltype = mimetypes.lookup(doc.key);
  if (urltype && urltype !== 'application/octet-stream') {
    mimetype = urltype;
  }

  var acceptable = [doc.mimetype, '$/*', '*/*'];
  var slashindex = doc.mimetype.indexOf('/');
  if (slashindex > -1) {
    acceptable[1] = acceptable[1].replace('$', doc.mimetype.substring(0, slashindex));
  }

  var allowedByContentType = (!!urltype) || ct == null;
  if (!allowedByContentType) {
    for (var i=0; i<acceptable.length; i++) {
      if (ct.indexOf(acceptable[i]) > -1) {
        allowedByContentType = true;
        break;
      }
    }
  }

  if (!allowedByContentType) {
    winston.warn('document content type is not allowed per request', { requested: ct, doctype: doc.mimetype, urltype: urltype });
    response.writeHead(415, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'Requested document does not support acceptable content-type' }));
    return null;
  }

  return {
    'content-type': mimetype,
    'content-length': doc.size,
    'x-haste-key': doc.key,
    'x-haste-name': doc.name,
    'x-haste-size': doc.size,
    'x-haste-syntax': doc.syntax,
    'x-haste-mimetype': doc.mimetype,
    'x-haste-encoding': doc.encoding ? doc.encoding : "utf-8",
    'x-haste-time': doc.time ? doc.time : ""
  };
};

// Handle adding a new Document
DocumentHandler.prototype.handlePost = function (request, response) {
  var _this = this;

  var metadata = {
    name: '',
    size: 0,
    syntax: '',
    mimetype: 'text/plain',
    encoding: 'utf-8',
    time: new Date().getTime()
  };

  // If we should, parse a form to grab the data
  var ct = request.headers['content-type'];
  if (ct && ct.split(';')[0] === 'multipart/form-data') {
    var busboy = new Busboy({ headers: request.headers });
    busboy.on('field', function (fieldname, val) {
      if (fieldname === 'data') {
        metadata.size = val.length;
        val = _this._setUrlRedirectFromPaste(metadata, val);
        _this._setStoreObject(metadata, val, response);
      }
    });
    busboy.on('file', function(fieldname, file, filename, encoding, mimetype) {
      if (mimetype == 'application/octet-stream') {
        var detectedType = mimetypes.lookup(filename);
        if (detectedType) {
          mimetype = detectedType;
        }
      }

      metadata.name = filename;
      metadata.mimetype = mimetype;
      metadata.encoding = encoding;
      var extIndex = filename.lastIndexOf('.');
      if (extIndex > -1 && extIndex < filename.length - 1) {
        metadata.syntax = filename.substring(extIndex + 1);
      }

      var chunks = [];
      file.on('data', function(chunk) {
        chunks.push(chunk);
      });
      file.on('end', function() {
        var buffer = Buffer.concat(chunks);
        metadata.size = buffer.length;
        _this._setStoreObject(metadata, buffer, response);
      });
      file.on('error', function(err) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify(err));
      });
    });
    request.pipe(busboy);
  // Otherwise, use our own and just grab flat data from POST body
  } else {
    var cancelled = false;
    var chunks = [];
    request.on('data', function (chunk) {
      chunks.push(chunk);
    });
    request.on('end', function () {
      if (!cancelled) {
        var buffer = Buffer.concat(chunks);
        metadata.size = buffer.length;
        buffer = _this._setUrlRedirectFromPaste(metadata, buffer);
        _this._setStoreObject(metadata, buffer, response);
      }
    });
    request.on('error', function (error) {
      winston.error('connection error: ' + error.message);
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'Connection error.' }));
      cancelled = true;
    });
  }
};

DocumentHandler.prototype._setUrlRedirectFromPaste = function(metadata, buffer) {
  try {
    var protocolLen = Math.min(buffer.length, 8);
    var protocol = buffer.toString('utf-8', 0, protocolLen).toLowerCase();
    if (protocol.indexOf('http://') == 0 || protocol.indexOf('https://') == 0) {
      var onlyUrl = buffer.toString('utf-8').replace('\r', '');
      lines = onlyUrl.split('\n');
      if (lines.length == 1) {
        metadata.mimetype = 'url-redirect';
        return new Buffer(lines[0]);
      }
    }
  } catch (e) {}
  return buffer;
};

DocumentHandler.prototype.handleRecent = function(request, response) {
  this.store.getRecent(function(reply) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply));
  });
};

DocumentHandler.prototype.handleKeys = function(request, response) {
  var _this = this;
  var keys = request.params.keys.split(',');
  _this.store.getMetadata(keys, function(reply) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply));
  });
};

// Keep choosing keys until one isn't taken
DocumentHandler.prototype.chooseKey = function(callback) {
  var key = this.acceptableKey();
  var _this = this;
  this.store.get(key, function(ret) {
    if (ret) {
      _this.chooseKey(callback);
    } else {
      callback(key);
    }
  });
};

DocumentHandler.prototype.acceptableKey = function() {
  return this.keyGenerator.createKey(this.keyLength);
};

module.exports = DocumentHandler;

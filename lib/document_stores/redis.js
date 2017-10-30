var redis = require('redis');
var winston = require('winston');

// For storing in redis
// options[type] = redis
// options[host] - The host to connect to (default localhost)
// options[port] - The port to connect to (default 5379)
// options[db] - The db to use (default 0)
// options[expire] - The time to live for each key set (default never)

var RedisDocumentStore = function(options, client) {
  this.expire = options.expire;
  if (client) {
    winston.info('using predefined redis client');
    RedisDocumentStore.client = client;
  } else if (!RedisDocumentStore.client) {
    winston.info('configuring redis');
    RedisDocumentStore.connect(options);
  }
};

RedisDocumentStore.connect = function(options) {
  var host = options.host || '127.0.0.1';
  var port = options.port || 6379;
  var index = options.db || 0;
  RedisDocumentStore.client = redis.createClient(port, host);
  if (options.password) {
    RedisDocumentStore.client.auth(options.password);
  }
  RedisDocumentStore.client.select(index, function(err) {
    if (err) {
      winston.error(
        'error connecting to redis index ' + index,
        { error: err }
      );
      process.exit(1);
    }
    else {
      winston.info('connected to redis', { host: host, port: port, db: index });
    }
  });
};

RedisDocumentStore.prototype.set = function(key, info, data, callback, skipExpire) {
  var _this = this;
  var infoJson = JSON.stringify(info);

  var replycount = [];
  var transaction = RedisDocumentStore.client
    .multi()
    .mset('info.'+key, infoJson, 'data.'+key, data);
  
  if (!skipExpire && this.expire) {
    transaction = transaction
      .expire('info.'+key, this.expire)
      .expire('data.'+key, this.expire);
  }

  transaction = transaction
    .lrem('recent', 0, key)
    .lpush('recent', key)
    .ltrim('recent', 0, 19);
  
  transaction.exec(function(err, replies) {
    if (err) {
      callback(false);
      return;
    }
    callback(true);
  });
};

RedisDocumentStore.prototype.get = function(key, callback, skipExpire) {
  var _this = this;

  RedisDocumentStore.client.mget('info.'+key, 'data.'+key, function(err, reply) {
    if (err) {
      callback(false);
      return;
    }
    for (var i=0; i<reply.length; i++) {
      if (!reply[i]) {
        callback(false)
        return;
      }
    }

    if (!skipExpire && this.expire) {
      var transaction= RedisDocumentStore.client
        .multi()
        .expire('info.'+key, this.expire)
        .expire('data.'+key, this.expire)
        .exec();
    }

    callback(reply);
  });
};

RedisDocumentStore.prototype.getMetadata = function(keys, callback) {
  keys = keys.map(function(key) {
    return 'info.' + key;
  });
  RedisDocumentStore.client.mget(keys, function(err, reply) {
    if (err) {
      winston.error('failed to get keys', { err: err });
      callback([]);
      return;
    }

    var recent = [];
    for (var i=0; i<reply.length; i++) {
      if (reply[i]) {
        var item = JSON.parse(reply[i]);
        item.key = keys[i].substring(5);
        recent.push(item);
      }
    }
    callback(recent);
  });
};

// Expire a key in expire time if set
RedisDocumentStore.prototype.setExpiration = function(key) {
  if (this.expire) {
    RedisDocumentStore.client.expire(key, this.expire, function(err) {
      if (err) {
        winston.error('failed to set expiry on key: ' + key);
      }
    });
  }
};

RedisDocumentStore.prototype.getRecent = function(callback) {
  RedisDocumentStore.client.lrange('recent', '0', '-1').then(function(reply) {
    if (!reply) {
      winston.error('failed to get recent', { reply: reply });
      callback([]);
      return;
    }
    reply = reply.map(function(key) {
      return key.substring(6);
    });
    this.getMetadata(reply, callback);
  }, function() {
    winston.error('failed to get recent', { reply: reply });
    callback([]);
  });
};

module.exports = RedisDocumentStore;

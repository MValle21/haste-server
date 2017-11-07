const Redis = require('ioredis');
const winston = require('winston');

let makeInfoKey = s => `info.${s}`;
let makeDataKey = s => `data.${s}`;

class RedisDocumentStore {
  /**
   * See the documentation for ioredis to see all the options you can pass.
   */
  constructor(options) {
    this.options = options;
    this.client = null;
  }

  /**
   * Open the connection to redis.
   */
  connect() {
    if (process.env.REDISTOGO_URL) {
      this.client = new Redis(process.env.REDISTOGO_URL);
    } else {
      this.client = new Redis(this.options);
    }
  }

  /**
   * Stores a document using the given metadata (info) and data.
   * 
   * Parameters:
   *  * `info`: an object containing metadata about the document
   *  * `data`: the raw data for the document zipped and base64 encoded as a string
   *  * `setOptions.isStatic`: whether or not the document is static (static documents don't expire)
   * 
   * If any part of the set operation fails an error is logged and thrown.
   */
  async set(key, info, data, setOptions = {}) {
    const infoKey = makeInfoKey(key);
    const dataKey = makeDataKey(key);
    const infoJson = JSON.stringify(info);
    const isStatic = ('isStatic' in setOptions) ? setOptions.isStatic : false;

    // multi() starts a transaction and returns a pipeline
    // the pipe allows us to queue up commands that will all be executed on the server together
    // we don't need WATCH here because the whole thing takes place inside a single transaction
    let pipe = this.client.multi();
    pipe.mset(infoKey, infoJson, dataKey, data);
    if (!isStatic && this.options.expire) {
      pipe.expire(infoKey, this.options.expire);
      pipe.expire(dataKey, this.options.expire);
    }
    pipe.lrem('recent', 0, key);
    pipe.lpush('recent', key);
    pipe.ltrim('recent', 0, 19);

    let ret = await pipe.exec();
    if (ret.some(a => a[0] != null)) {
      winston.error("error during set", ret);
      throw new Error("Some or all of the set operation failed");
    }
  }

  /**
   * Retrieves a document from the data store.
   * 
   * Parameters:
   *  * `key`: the key of the document to retrieve
   *  * `getOptions.isStatic`: whether or not the document is static (static documents don't expire)
   * 
   * Returns an object with 2 fields:
   *  * `info`: The metadata object containing information about the document
   *  * `data`: The zipped + base64 encoded contents of the document
   */
  async get(key, getOptions = {}) {
    const infoKey = makeInfoKey(key);
    const dataKey = makeDataKey(key);
    const isStatic = ('isStatic' in getOptions) ? getOptions.isStatic : false;

    let result = await this.client.mget(infoKey, dataKey);

    if (!isStatic && this.options.expire) {
      await this.client.multi()
        .expire(infoKey, this.options.expire)
        .expire(dataKey, this.options.expire)
        .exec();
    }

    return { info: JSON.parse(result[0]), data: result[1] };
  }

  /**
   * Retrieves the metadata objects for the given documents and returns them as an array
   * of objects.
   */
  async getMetadata(keys) {
    let infoKeys = keys.map(makeInfoKey);
    let infoStrs = await this.client.mget(infoKeys);
    return infoStrs
      .filter(info => info != null)
      .map(JSON.parse);
  }

  /**
   * Returns the metadata objects for the recently added documents
   */
  async getRecent() {
    let recentKeys = await this.client.lrange('recent', '0', '-1');
    return await this.getMetadata(recentKeys);
  }
}

module.exports = RedisDocumentStore;

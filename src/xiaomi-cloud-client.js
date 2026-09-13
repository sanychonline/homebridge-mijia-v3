'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

const DEFAULT_SESSION_FILE = process.env.XIAOMI_SESSION_FILE;
const DEFAULT_CACHE_FILE = path.join(os.homedir(), '.homebridge-mijia-v3-session.json');

const SERVER_HOSTS = {
  cn: 'https://api.io.mi.com/app',
  de: 'https://de.api.io.mi.com/app',
  us: 'https://us.api.io.mi.com/app',
  ru: 'https://ru.api.io.mi.com/app',
  sg: 'https://sg.api.io.mi.com/app',
  i2: 'https://i2.api.io.mi.com/app',
};

class XiaomiCloudClient {
  constructor(options = {}, log = console) {
    this.username = options.username;
    this.password = options.password;
    this.twoFactorUrl = options.twoFactorUrl;
    this.twoFactorTicket = options.twoFactorTicket;
    this.server = options.server || 'de';
    this.sessionFile = expandPath(options.sessionFile || process.env.XIAOMI_SESSION_FILE || DEFAULT_SESSION_FILE);
    this.cacheFile = expandPath(options.cacheFile || DEFAULT_CACHE_FILE);
    this.log = log;
    this.session = null;
    this.jar = new CookieJar();
    this.http = wrapper(axios.create({ jar: this.jar, withCredentials: true, timeout: 15000 }));
    this.miotCloud = null;
  }

  async ensureLogin() {
    if (this.session && this.session.ssecurity && this.session.serviceToken) {
      return this.session;
    }

    const externalSession = this.loadSessionFile(this.sessionFile);
    if (externalSession) {
      this.session = externalSession;
      this.configureMiotCloud(this.session);
      return this.session;
    }

    const cachedSession = this.loadSessionFile(this.cacheFile);
    if (cachedSession) {
      this.session = cachedSession;
      this.configureMiotCloud(this.session);
      this.saveSession(this.sessionFile, this.session);
      return this.session;
    }

    if (this.twoFactorUrl && this.twoFactorTicket) {
      this.session = await this.loginWithTwoFactor(this.twoFactorUrl, this.twoFactorTicket);
      this.configureMiotCloud(this.session);
      this.saveSession(this.sessionFile, this.session);
      this.saveSession(this.cacheFile, this.session);
      return this.session;
    }

    if (!this.username || !this.password) {
      throw new Error('Xiaomi credentials are not configured and no valid sessionFile was found.');
    }

    this.session = await this.loginWithPassword();
    this.configureMiotCloud(this.session);
    this.saveSession(this.cacheFile, this.session);
    return this.session;
  }

  loadSessionFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const session = {
        ssecurity: raw.ssecurity,
        serviceToken: raw.serviceToken,
        userId: raw.userId || raw.user_id,
        cUserId: raw.cUserId,
        passToken: raw.passToken,
        agentId: raw.agentId,
        clientId: raw.clientId,
        loginMethod: raw.loginMethod,
        loggedInAt: raw.loggedInAt,
        timestamp: raw.timestamp,
      };

      if (!session.ssecurity || !session.serviceToken || !session.userId) {
        return null;
      }

      this.jar.setCookieSync(`serviceToken=${session.serviceToken}`, this.apiBaseUrl());
      this.jar.setCookieSync(`userId=${session.userId}`, this.apiBaseUrl());
      return session;
    } catch (error) {
      this.log.warn && this.log.warn(`Could not load Xiaomi session file ${filePath}: ${error.message}`);
      return null;
    }
  }

  configureMiotCloud(session) {
    try {
      const MiCloud = require('homebridge-miot/lib/protocol/MiCloud');
      const logger = {
        debug: (message) => this.log.debug && this.log.debug(message),
        deepDebug: (message) => this.log.debug && this.log.debug(message),
      };
      const cloud = new MiCloud(logger);
      cloud.setCountry(this.server);
      cloud.setRequestTimeout(15000);
      cloud.setServiceToken(session);
      this.miotCloud = cloud;
    } catch (error) {
      this.miotCloud = null;
      this.log.debug && this.log.debug(`homebridge-miot MiCloud transport is not available: ${error.message}`);
    }
  }

  saveSession(filePath, session) {
    if (!filePath || !session) {
      return;
    }

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(session, null, 2), { mode: 0o600 });
      fs.chmodSync(filePath, 0o600);
    } catch (error) {
      this.log.warn && this.log.warn(`Could not save Xiaomi session cache: ${error.message}`);
    }
  }

  async loginWithPassword() {
    const session = await this.loginWithMiotPassword();
    if (session) {
      return session;
    }

    const clientId = crypto.randomBytes(6).toString('hex').toUpperCase();
    const service = 'xiaomiio';
    const loginUrl = `https://account.xiaomi.com/pass/serviceLogin?sid=${service}&_json=true`;
    const step1 = await this.http.get(loginUrl, { headers: this.loginHeaders() });
    const loginContext = parseXiaomiJson(step1.data);

    const hash = crypto.createHash('md5').update(this.password).digest('hex').toUpperCase();
    const params = new URLSearchParams({
      sid: service,
      hash,
      callback: 'https://sts.api.io.mi.com/sts',
      qs: '%3Fsid%3Dxiaomiio%26_json%3Dtrue',
      user: this.username,
      _sign: loginContext._sign,
      _json: 'true',
    });

    const step2 = await this.http.post('https://account.xiaomi.com/pass/serviceLoginAuth2', params, {
      headers: {
        ...this.loginHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    const auth = parseXiaomiJson(step2.data);

    if (!auth.location || !auth.ssecurity || !auth.userId) {
      throw new Error(`Xiaomi login failed: ${auth.desc || auth.message || 'missing session fields'}`);
    }

    const step3 = await this.http.get(auth.location, {
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 400,
      headers: this.loginHeaders(),
    });

    const cookies = step3.headers['set-cookie'] || [];
    const tokenCookie = cookies.find(cookie => cookie.startsWith('serviceToken='));
    const serviceToken = tokenCookie && tokenCookie.split(';')[0].split('=').slice(1).join('=');

    if (!serviceToken) {
      throw new Error('Xiaomi login failed: serviceToken cookie not found.');
    }

    return {
      ssecurity: auth.ssecurity,
      serviceToken,
      userId: String(auth.userId),
      agentId: clientId,
      clientId,
      loggedInAt: new Date().toISOString(),
      timestamp: Date.now(),
    };
  }

  async loginWithMiotPassword() {
    const cloud = this.createMiotCloud();
    if (!cloud) {
      return null;
    }

    try {
      await cloud.login(this.username, this.password);
      return cloud.getServiceToken();
    } catch (error) {
      if (error?.notificationUrl) {
        throw new Error(`Xiaomi two-factor authentication required. Open this URL, complete verification, then set twoFactorUrl and twoFactorTicket in Xiaomi 1080p settings: ${error.notificationUrl}`);
      }
      if (String(error?.message || '').includes('Two factor authentication required')) {
        throw error;
      }
      this.log.debug && this.log.debug(`homebridge-miot password login failed, falling back to built-in login: ${error.message}`);
      return null;
    }
  }

  async loginWithTwoFactor(verifyUrl, ticket) {
    const cloud = this.createMiotCloud();
    if (!cloud) {
      throw new Error('homebridge-miot MiCloud transport is required for Xiaomi 2FA login but is not available.');
    }

    await cloud.loginTwoFa(verifyUrl, ticket);
    return cloud.getServiceToken();
  }

  async createQrLogin(locale = 'zh_CN') {
    const cloud = this.createMiotCloud();
    if (!cloud) {
      throw new Error('homebridge-miot MiCloud transport is required for Xiaomi QR login but is not available.');
    }
    return cloud.createQrLogin(locale);
  }

  async pollQrLogin(lpUrl) {
    const cloud = this.createMiotCloud();
    if (!cloud) {
      throw new Error('homebridge-miot MiCloud transport is required for Xiaomi QR login but is not available.');
    }
    return cloud.pollQrLogin(lpUrl);
  }

  async completeQrLogin(qrLoginData) {
    const cloud = this.createMiotCloud();
    if (!cloud) {
      throw new Error('homebridge-miot MiCloud transport is required for Xiaomi QR login but is not available.');
    }
    await cloud.completeQrLogin(qrLoginData);
    const session = cloud.getServiceToken();
    this.saveSession(this.sessionFile, session);
    this.saveSession(this.cacheFile, session);
    return session;
  }

  createMiotCloud() {
    try {
      const MiCloud = require('homebridge-miot/lib/protocol/MiCloud');
      const logger = {
        debug: (message) => this.log.debug && this.log.debug(message),
        deepDebug: (message) => this.log.debug && this.log.debug(message),
      };
      const cloud = new MiCloud(logger);
      cloud.setCountry(this.server);
      cloud.setRequestTimeout(15000);
      return cloud;
    } catch (error) {
      this.log.debug && this.log.debug(`homebridge-miot MiCloud login transport is not available: ${error.message}`);
      return null;
    }
  }

  loginHeaders() {
    return {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 MiHome/9.0',
      Accept: '*/*',
    };
  }

  apiBaseUrl() {
    return SERVER_HOSTS[this.server] || SERVER_HOSTS.de;
  }

  async callMiotAction(did, siid, aiid, inArgs = []) {
    await this.ensureLogin();
    return this.signedRequest('/miotspec/action', {
      params: {
        did: String(did),
        siid,
        aiid,
        in: inArgs,
      },
    });
  }

  async getMiotProperties(params) {
    await this.ensureLogin();
    return this.signedRequest('/miotspec/prop/get', { params });
  }

  async setMiotProperties(params) {
    await this.ensureLogin();
    return this.signedRequest('/miotspec/prop/set', { params });
  }

  async signedRequest(endpoint, payload) {
    await this.ensureLogin();
    if (this.miotCloud) {
      return this.miotCloud.request(endpoint, payload);
    }

    const session = this.session;
    const nonce = crypto.randomBytes(8).toString('base64');
    const signedNonce = crypto
      .createHash('sha256')
      .update(Buffer.concat([Buffer.from(session.ssecurity, 'base64'), Buffer.from(nonce, 'base64')]))
      .digest('base64');

    const data = JSON.stringify(payload);
    const signature = signMiioRequest(endpoint, signedNonce, nonce, data);
    const form = new URLSearchParams({ _nonce: nonce, data, signature });

    const response = await this.http.post(`${this.apiBaseUrl()}${endpoint}`, form, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'MiHome/9.0',
      },
    });

    return typeof response.data === 'string' ? parseXiaomiJson(response.data) : response.data;
  }

  async getMissStreamDescriptor(did, options = {}) {
    await this.ensureLogin();

    const keyPair = generateX25519KeyPair();
    const response = await this.signedRequest('/v2/device/miss_get_vendor', {
      app_pubkey: keyPair.publicKey,
      did: String(did),
      support_vendors: options.supportVendors || 'TUTK_CS2_MTP',
    });
    const result = unwrapXiaomiResult(response);
    if (!result?.vendor?.vendor) {
      throw new Error(`Xiaomi MISS vendor response did not include a vendor: ${JSON.stringify(response)}`);
    }

    return {
      did: String(did),
      ip: options.ip || result.localip || result.local_ip || result.ip,
      model: options.model,
      subtype: options.subtype || options.profile || 'sd',
      vendor: vendorName(result.vendor.vendor),
      vendorId: result.vendor.vendor,
      uid: result.vendor.vendor_params?.p2p_id,
      region: result.region,
      missVersion: result.miss_version || '',
      license: result.vendor.vendor_params?.license,
      deviceKey: options.deviceKey,
      clientPublic: keyPair.publicKey,
      clientPrivate: keyPair.privateKey,
      devicePublic: result.public_key,
      sign: result.sign,
      raw: result,
    };
  }

  async getCameraPower(did) {
    const response = await this.getMiotProperties([
      { did: String(did), siid: 2, piid: 1 },
    ]);
    const result = response && response.result;
    const item = Array.isArray(result) ? result[0] : result;
    if (!item || item.code !== 0) {
      throw new Error(`Could not read Xiaomi camera power state: ${JSON.stringify(response)}`);
    }
    return Boolean(item.value);
  }

  async setCameraPower(did, value) {
    const response = await this.setMiotProperties([
      { did: String(did), siid: 2, piid: 1, value: Boolean(value) },
    ]);
    const result = response && response.result;
    const item = Array.isArray(result) ? result[0] : result;
    if (!item || item.code !== 0) {
      throw new Error(`Could not set Xiaomi camera power state: ${JSON.stringify(response)}`);
    }
    return Boolean(value);
  }

}

function signMiioRequest(pathname, signedNonce, nonce, data) {
  const stringToSign = [pathname, signedNonce, nonce, `data=${data}`].join('&');
  return crypto.createHmac('sha256', Buffer.from(signedNonce, 'base64')).update(stringToSign).digest('base64');
}

function generateX25519KeyPair() {
  const keyPair = crypto.generateKeyPairSync('x25519');
  return {
    publicKey: keyPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
    privateKey: keyPair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex'),
  };
}

function unwrapXiaomiResult(response) {
  if (response?.code === 0 && response.result) {
    return response.result;
  }
  if (response?.result && !response.result.code) {
    return response.result;
  }
  return response;
}

function vendorName(vendorId) {
  switch (vendorId) {
    case 1:
      return 'tutk';
    case 3:
      return 'agora';
    case 4:
      return 'cs2';
    case 6:
      return 'mtp';
    default:
      return String(vendorId);
  }
}

function parseXiaomiJson(value) {
  if (typeof value !== 'string') {
    return value;
  }
  const clean = value.replace(/^&&&START&&&/, '').trim();
  return JSON.parse(clean);
}

function expandPath(filePath) {
  if (!filePath) {
    return filePath;
  }
  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

module.exports = {
  XiaomiCloudClient,
  DEFAULT_SESSION_FILE,
};

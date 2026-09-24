"use strict";

const fs = require("fs").promises;
const path = require("path");
const { HomebridgePluginUiServer } = require("@homebridge/plugin-ui-utils");

const SESSION_DIR = ".xiaomi-1080p";
const SESSION_FILE = "cachedSession";

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.onRequest("/login-to-micloud", this.loginToMiCloud.bind(this));
    this.onRequest("/create-micloud-qr-login", this.createMiCloudQrLogin.bind(this));
    this.onRequest("/poll-micloud-qr-login", this.pollMiCloudQrLogin.bind(this));
    this.onRequest("/get-cached-micloud-session", this.getCachedMiCloudSession.bind(this));
    this.onRequest("/clear-cached-micloud-session", this.clearCachedMiCloudSession.bind(this));

    this.ready();
  }

  async loginToMiCloud(params = {}) {
    const miCloud = this.createMiCloud(params.country || params.server || "de");
    const username = params.username;
    const password = params.password;
    const verifyUrl = params.verifyUrl;
    const twoFaTicket = params.twoFaTicket;

    if (verifyUrl && twoFaTicket) {
      try {
        await miCloud.loginTwoFa(verifyUrl, twoFaTicket);
      } catch (error) {
        return {
          success: false,
          error: `2FA login failed with error: ${error.message}`,
        };
      }
    } else {
      if (!username || !password) {
        return {
          success: false,
          error: "Username and password are required for password login. Use QR login if you do not want to enter credentials.",
        };
      }

      try {
        await miCloud.login(username, password);
      } catch (error) {
        if (error?.notificationUrl || String(error.message || "").includes("Two factor authentication required")) {
          return {
            success: false,
            error: "Two factor authentication required, please visit the specified URL and retry login with the verification ticket.",
            url: error.notificationUrl,
          };
        }

        return {
          success: false,
          error: `${error.message}! The specified MiCloud credentials might be incorrect or the account does not exist.`,
        };
      }
    }

    try {
      await this.saveCachedMiCloudSession(miCloud.getServiceToken());
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: `Failed to save MiCloud session: ${error.message}`,
      };
    }
  }

  async createMiCloudQrLogin(params = {}) {
    const miCloud = this.createMiCloud(params.country || params.server || "de");
    try {
      const qrLogin = await miCloud.createQrLogin(params.locale || "zh_CN");
      return {
        success: true,
        qr: qrLogin.qr,
        lp: qrLogin.lp,
        loginUrl: qrLogin.loginUrl,
        timeout: qrLogin.timeout,
        timeInterval: qrLogin.timeInterval,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to create MiCloud QR login: ${error.message}`,
      };
    }
  }

  async pollMiCloudQrLogin(params = {}) {
    const miCloud = this.createMiCloud(params.country || params.server || "de");
    try {
      const qrLoginData = await miCloud.pollQrLogin(params.lp);
      if (!qrLoginData.success) {
        return {
          success: false,
          pending: true,
          code: qrLoginData.code,
          desc: qrLoginData.desc,
        };
      }

      await miCloud.completeQrLogin(qrLoginData);
      const serviceToken = miCloud.getServiceToken();
      await this.saveCachedMiCloudSession(serviceToken);

      return {
        success: true,
        cachedSession: this.safeSessionMetadata(serviceToken),
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to complete MiCloud QR login: ${error.message}`,
      };
    }
  }

  async getCachedMiCloudSession() {
    try {
      const session = JSON.parse(await fs.readFile(this.sessionFile(), "utf8"));
      return {
        success: true,
        cachedSession: this.safeSessionMetadata(session),
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to get cached MiCloud session: ${error.message}`,
      };
    }
  }

  async clearCachedMiCloudSession() {
    try {
      await fs.unlink(this.sessionFile());
      return { success: true };
    } catch (error) {
      if (error.code === "ENOENT") {
        return { success: true };
      }
      return {
        success: false,
        error: `Failed to clear cached MiCloud session: ${error.message}`,
      };
    }
  }

  createMiCloud(country) {
    const MiCloud = require("homebridge-miot/lib/protocol/MiCloud");
    const logger = {
      debug: () => {},
      deepDebug: () => {},
    };
    const miCloud = new MiCloud(logger);
    miCloud.setCountry(country || "de");
    miCloud.setRequestTimeout(10000);
    return miCloud;
  }

  async saveCachedMiCloudSession(serviceToken) {
    const dir = path.join(this.homebridgeStoragePath, SESSION_DIR);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.sessionFile(), JSON.stringify(serviceToken, null, 2), { mode: 0o600 });
    await fs.chmod(this.sessionFile(), 0o600);
  }

  sessionFile() {
    return path.join(this.homebridgeStoragePath, SESSION_DIR, SESSION_FILE);
  }

  safeSessionMetadata(session) {
    if (!session) {
      return null;
    }
    return {
      ready: Boolean(session.ssecurity && session.serviceToken && session.agentId && session.clientId),
      loggedInAt: session.loggedInAt,
      loginMethod: session.loginMethod,
    };
  }
}

(() => new UiServer())();

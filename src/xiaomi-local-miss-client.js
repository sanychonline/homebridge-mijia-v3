"use strict";

const fs = require("fs");
const path = require("path");
const { XiaomiMissMediaReader } = require("./xiaomi-miss-media-reader");

const descriptorRefreshes = new Map();

class XiaomiLocalMissClient {
  constructor(platform, cloud, config, dependencies = {}) {
    this.platform = platform;
    this.cloud = cloud;
    this.config = config;
    this.createReader = dependencies.createReader
      || ((descriptor, options) => new XiaomiMissMediaReader(this.platform, descriptor, options));
  }

  async startStream(options = {}) {
    if (!this.config.deviceKey) {
      throw new Error(
        `Local Xiaomi MISS streaming for ${this.config.name || this.config.did} requires deviceKey in config.json.`,
      );
    }

    const descriptor = await this.resolveDescriptor();
    try {
      return await this.openStream(descriptor, options);
    } catch (error) {
      if (!isMissAuthFailure(error)) {
        throw error;
      }

      const refreshed = await this.recoverDescriptorAfterAuthFailure(descriptor);
      return this.openStream(refreshed, options);
    }
  }

  async openStream(descriptor, options = {}) {
    const videoQuality = options.videoQuality
      || this.config.missVideoQuality
      || this.config.videoQuality
      || this.config.subtype
      || this.config.profile
      || descriptor.subtype;
    const reader = this.createReader(descriptor, {
      audio: options.audio !== undefined ? Boolean(options.audio) : this.config.audio !== false,
      videoQuality,
      channel: this.config.missChannel ?? this.config.channel,
    });

    this.platform.log.info(
      `Resolved local Xiaomi MISS stream for ${this.config.name || this.config.did}: ${JSON.stringify(reader.toSafeSummary())}`,
    );

    try {
      await reader.open();
    } catch (error) {
      reader.close?.();
      throw error;
    }
    return {
      url: reader.toMissUrl(),
      descriptor,
      reader,
    };
  }

  async resolveDescriptor() {
    const mode = this.config.cloudBootstrap || "fallback";
    const cached = mode !== "always" ? this.loadCachedDescriptor() : null;
    if (cached) {
      this.platform.log.info(`Using cached local Xiaomi MISS descriptor for ${this.config.name || this.config.did}`);
      return this.applyDescriptorOverrides(cached);
    }

    if (mode === "local") {
      throw new Error(`Local Xiaomi MISS descriptor cache is missing for ${this.config.name || this.config.did}; set cloudBootstrap=fallback once to refresh it, then switch back to local.`);
    }

    if (mode === "cacheOnly") {
      this.platform.log.warn(`cloudBootstrap=cacheOnly is a legacy setting. MISS descriptor cache is missing for ${this.config.name || this.config.did}; refreshing it once through Xiaomi Cloud session.`);
    }

    return this.fetchAndCacheDescriptor();
  }

  async recoverDescriptorAfterAuthFailure(failedDescriptor) {
    const mode = this.config.cloudBootstrap || "fallback";
    if (mode === "local") {
      const error = new Error(
        `Cached Xiaomi MISS descriptor was rejected for ${this.config.name || this.config.did}; `
        + "strict local mode cannot refresh it. Temporarily set cloudBootstrap=fallback and ensure the plugin Xiaomi session is signed in.",
      );
      error.code = "XIAOMI_MISS_AUTH_REFRESH_REQUIRED";
      throw error;
    }

    const refreshKey = `${this.descriptorCachePath()}::${String(this.config.did)}`;
    let refresh = descriptorRefreshes.get(refreshKey);
    if (!refresh) {
      refresh = this.refreshDescriptorAfterAuthFailure(failedDescriptor)
        .finally(() => descriptorRefreshes.delete(refreshKey));
      descriptorRefreshes.set(refreshKey, refresh);
    } else {
      this.platform.log.info(
        `Waiting for Xiaomi MISS descriptor refresh already in progress for ${this.config.name || this.config.did}`,
      );
    }
    return refresh;
  }

  async refreshDescriptorAfterAuthFailure(failedDescriptor) {
    const current = this.loadCachedDescriptor();
    if (current && !sameAuthDescriptor(current, failedDescriptor)) {
      this.platform.log.info(
        `Using Xiaomi MISS descriptor refreshed by another stream for ${this.config.name || this.config.did}`,
      );
      return this.applyDescriptorOverrides(current);
    }

    this.platform.log.warn(
      `Cached Xiaomi MISS descriptor was rejected for ${this.config.name || this.config.did}; refreshing it once through the authenticated Xiaomi session.`,
    );
    return this.fetchAndCacheDescriptor();
  }

  async fetchAndCacheDescriptor() {
    const descriptor = await this.cloud.getMissStreamDescriptor(this.config.did, {
      ip: this.config.ip || this.config.localip || this.config.localIp || this.config.host,
      model: this.config.model,
      subtype: this.config.subtype || this.config.profile || "sd",
      deviceKey: this.config.deviceKey,
    });
    this.saveCachedDescriptor(descriptor);
    return descriptor;
  }

  applyDescriptorOverrides(descriptor) {
    return {
      ...descriptor,
      did: String(this.config.did || descriptor.did),
      ip: this.config.ip || this.config.localip || this.config.localIp || this.config.host || descriptor.ip,
      model: this.config.model || descriptor.model,
      subtype: this.config.subtype || this.config.profile || descriptor.subtype || "sd",
      deviceKey: this.config.deviceKey || descriptor.deviceKey,
    };
  }

  descriptorCachePath() {
    if (this.config.descriptorCacheFile) {
      return this.config.descriptorCacheFile;
    }

    const storagePath = this.platform.api?.user?.storagePath?.() || process.cwd();
    return path.join(storagePath, ".xiaomi-1080p", "miss-descriptors.json");
  }

  loadCachedDescriptor() {
    const filePath = this.descriptorCachePath();
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }

    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const descriptor = data[String(this.config.did)];
      if (!descriptor || !descriptor.clientPrivate || !descriptor.clientPublic || !descriptor.devicePublic || !descriptor.sign) {
        return null;
      }
      return descriptor;
    } catch (error) {
      this.platform.log.warn(`Could not read Xiaomi MISS descriptor cache for ${this.config.name || this.config.did}: ${error.message}`);
      return null;
    }
  }

  saveCachedDescriptor(descriptor) {
    const filePath = this.descriptorCachePath();
    if (!filePath || !descriptor) {
      return;
    }

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      let data = {};
      if (fs.existsSync(filePath)) {
        data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      }
      data[String(this.config.did)] = descriptor;
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.chmodSync(filePath, 0o600);
      this.platform.log.info(`Saved local Xiaomi MISS descriptor cache for ${this.config.name || this.config.did}`);
    } catch (error) {
      this.platform.log.warn(`Could not save Xiaomi MISS descriptor cache for ${this.config.name || this.config.did}: ${error.message}`);
    }
  }
}

function isMissAuthFailure(error) {
  return error?.code === "XIAOMI_MISS_AUTH_FAILED"
    || /^Xiaomi MISS auth failed\b/.test(error?.message || "");
}

function sameAuthDescriptor(left, right) {
  return left?.clientPublic === right?.clientPublic
    && left?.devicePublic === right?.devicePublic
    && left?.sign === right?.sign;
}

module.exports = { XiaomiLocalMissClient };

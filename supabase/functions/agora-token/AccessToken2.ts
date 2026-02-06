// Deno port of Agora AccessToken2
// Source: https://github.com/AgoraIO/Tools/blob/master/DynamicKey/AgoraDynamicKey/nodejs/src/AccessToken2.js
// Only includes ServiceRtc (all we need for RTC tokens)

import { createHmac } from "node:crypto";
import { deflateSync } from "node:zlib";
import { Buffer } from "node:buffer";

const _VERSION_LENGTH = 3;
const APP_ID_LENGTH = 32;

function getVersion(): string {
  return "007";
}

function encodeHMac(key: Buffer, message: Buffer): Buffer {
  return createHmac("sha256", key).update(message).digest() as Buffer;
}

// ── ByteBuf (write) ──────────────────────────────────────────

class ByteBuf {
  buffer: Buffer;
  position: number;

  constructor() {
    this.buffer = Buffer.alloc(1024);
    this.buffer.fill(0);
    this.position = 0;
  }

  pack(): Buffer {
    const out = Buffer.alloc(this.position);
    this.buffer.copy(out, 0, 0, out.length);
    return out;
  }

  putUint16(v: number): ByteBuf {
    this.buffer.writeUInt16LE(v, this.position);
    this.position += 2;
    return this;
  }

  putUint32(v: number): ByteBuf {
    this.buffer.writeUInt32LE(v, this.position);
    this.position += 4;
    return this;
  }

  putBytes(bytes: Buffer): ByteBuf {
    this.putUint16(bytes.length);
    bytes.copy(this.buffer, this.position);
    this.position += bytes.length;
    return this;
  }

  putString(str: string): ByteBuf {
    return this.putBytes(Buffer.from(str));
  }

  putTreeMapUInt32(map: Record<number, number>): ByteBuf {
    if (!map) {
      this.putUint16(0);
      return this;
    }
    const keys = Object.keys(map);
    this.putUint16(keys.length);
    for (const key of keys) {
      this.putUint16(Number(key));
      this.putUint32(map[Number(key)]);
    }
    return this;
  }
}

// ── Service base ─────────────────────────────────────────────

class Service {
  __type: number;
  __privileges: Record<number, number>;

  constructor(serviceType: number) {
    this.__type = serviceType;
    this.__privileges = {};
  }

  __pack_type(): Buffer {
    const buf = new ByteBuf();
    buf.putUint16(this.__type);
    return buf.pack();
  }

  __pack_privileges(): Buffer {
    const buf = new ByteBuf();
    buf.putTreeMapUInt32(this.__privileges);
    return buf.pack();
  }

  service_type(): number {
    return this.__type;
  }

  add_privilege(privilege: number, expire: number): void {
    this.__privileges[privilege] = expire;
  }

  pack(): Buffer {
    return Buffer.concat([this.__pack_type(), this.__pack_privileges()]);
  }
}

// ── ServiceRtc ───────────────────────────────────────────────

const kRtcServiceType = 1;

class ServiceRtc extends Service {
  __channel_name: string;
  __uid: string;

  static kPrivilegeJoinChannel = 1;
  static kPrivilegePublishAudioStream = 2;
  static kPrivilegePublishVideoStream = 3;
  static kPrivilegePublishDataStream = 4;

  constructor(channelName: string, uid: number) {
    super(kRtcServiceType);
    this.__channel_name = channelName;
    this.__uid = uid === 0 ? "" : `${uid}`;
  }

  override pack(): Buffer {
    const buffer = new ByteBuf();
    buffer.putString(this.__channel_name).putString(this.__uid);
    return Buffer.concat([super.pack(), buffer.pack()]);
  }
}

// ── AccessToken2 ─────────────────────────────────────────────

class AccessToken2 {
  appId: string;
  appCertificate: string;
  issueTs: number;
  expire: number;
  salt: number;
  services: Record<number, Service>;

  constructor(
    appId: string,
    appCertificate: string,
    issueTs?: number,
    expire?: number
  ) {
    this.appId = appId;
    this.appCertificate = appCertificate;
    this.issueTs = issueTs || Math.floor(Date.now() / 1000);
    this.expire = expire || 3600;
    this.salt = Math.floor(Math.random() * 99999999) + 1;
    this.services = {};
  }

  __signing(): Buffer {
    let signing = encodeHMac(
      new ByteBuf().putUint32(this.issueTs).pack(),
      Buffer.from(this.appCertificate, "utf-8")
    );
    signing = encodeHMac(
      new ByteBuf().putUint32(this.salt).pack(),
      signing
    );
    return signing;
  }

  __build_check(): boolean {
    const isUuid = (data: string) => {
      if (data.length !== APP_ID_LENGTH) return false;
      try {
        Buffer.from(data, "hex");
        return true;
      } catch {
        return false;
      }
    };

    if (!isUuid(this.appId) || !isUuid(this.appCertificate)) return false;
    if (Object.keys(this.services).length === 0) return false;
    return true;
  }

  add_service(service: Service): void {
    this.services[service.service_type()] = service;
  }

  build(): string {
    if (!this.__build_check()) return "";

    const signing = this.__signing();

    let signing_info = new ByteBuf()
      .putString(this.appId)
      .putUint32(this.issueTs)
      .putUint32(this.expire)
      .putUint32(this.salt)
      .putUint16(Object.keys(this.services).length)
      .pack();

    for (const service of Object.values(this.services)) {
      signing_info = Buffer.concat([signing_info, service.pack()]);
    }

    const signature = encodeHMac(signing, signing_info);
    const content = Buffer.concat([
      new ByteBuf().putBytes(signature).pack(),
      signing_info,
    ]);
    const compressed = deflateSync(content);
    return `${getVersion()}${Buffer.from(compressed).toString("base64")}`;
  }
}

export { AccessToken2, ServiceRtc, kRtcServiceType };

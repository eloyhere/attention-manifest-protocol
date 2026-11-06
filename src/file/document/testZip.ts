import { deflateRawSync } from "node:zlib";

/** Test-only ZIP writer so document fixtures stay dependency-free. */
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        table[index] = value >>> 0;
    }
    return table;
})();

export function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
    return (crc ^ 0xffffffff) >>> 0;
}

function encode(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

function u16(view: DataView, offset: number, value: number): void {
    view.setUint16(offset, value, true);
}

function u32(view: DataView, offset: number, value: number): void {
    view.setUint32(offset, value >>> 0, true);
}

/** Builds a deflated ZIP archive from `name -> content`; order is preserved. */
export function createZip(files: Readonly<Record<string, string | Uint8Array>>): Uint8Array {
    const names = Object.keys(files);
    const locals: Uint8Array[] = [];
    const centrals: Uint8Array[] = [];
    let offset = 0;
    for (const name of names) {
        const raw = files[name];
        const bytes = typeof raw === "string" ? encode(raw) : raw ?? new Uint8Array();
        const deflated = deflateRawSync(bytes);
        const nameBytes = encode(name);
        const crc = crc32(bytes);
        const local = new Uint8Array(30 + nameBytes.length + deflated.length);
        const localView = new DataView(local.buffer);
        u32(localView, 0, 0x04034b50);
        u16(localView, 4, 20);
        u16(localView, 6, 0);
        u16(localView, 8, 8);
        u16(localView, 10, 0);
        u16(localView, 12, 0);
        u32(localView, 14, crc);
        u32(localView, 18, deflated.length);
        u32(localView, 22, bytes.length);
        u16(localView, 26, nameBytes.length);
        u16(localView, 28, 0);
        local.set(nameBytes, 30);
        local.set(deflated, 30 + nameBytes.length);
        const central = new Uint8Array(46 + nameBytes.length);
        const centralView = new DataView(central.buffer);
        u32(centralView, 0, 0x02014b50);
        u16(centralView, 4, 20);
        u16(centralView, 6, 20);
        u16(centralView, 8, 0);
        u16(centralView, 10, 8);
        u16(centralView, 12, 0);
        u16(centralView, 14, 0);
        u32(centralView, 16, crc);
        u32(centralView, 20, deflated.length);
        u32(centralView, 24, bytes.length);
        u16(centralView, 28, nameBytes.length);
        u16(centralView, 30, 0);
        u16(centralView, 32, 0);
        u16(centralView, 34, 0);
        u16(centralView, 36, 0);
        u32(centralView, 38, 0);
        u32(centralView, 42, offset);
        central.set(nameBytes, 46);
        locals.push(local);
        centrals.push(central);
        offset += local.length;
    }
    const directory = centrals.reduce((total, entry) => total + entry.length, 0);
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    u32(eocdView, 0, 0x06054b50);
    u16(eocdView, 4, 0);
    u16(eocdView, 6, 0);
    u16(eocdView, 8, names.length);
    u16(eocdView, 10, names.length);
    u32(eocdView, 12, directory);
    u32(eocdView, 16, offset);
    u16(eocdView, 20, 0);
    const total = offset + directory + eocd.length;
    const output = new Uint8Array(total);
    let cursor = 0;
    for (const local of locals) {
        output.set(local, cursor);
        cursor += local.length;
    }
    for (const central of centrals) {
        output.set(central, cursor);
        cursor += central.length;
    }
    output.set(eocd, cursor);
    return output;
}

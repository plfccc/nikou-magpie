import { gzipSync } from 'node:zlib';

export function makeTar(files) {
  const blocks = [];
  for (const [name, value] of Object.entries(files)) {
    const bytes = Buffer.from(value); const header = Buffer.alloc(512);
    header.write(name); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124); header.write('00000000000\0', 136); header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257);
    const checksum = header.reduce((a, b) => a + b, 0); header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

// Upload opcional; valida também a assinatura, não apenas o MIME declarado.
export function validarFotoContagem(foto?: { buffer: Buffer; mimeType: string }): void {
  if (!foto) return;
  const b = foto.buffer;
  const jpeg = b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const png = b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const webp = b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
  if (b.length > 8 * 1024 * 1024 || !(jpeg || png || webp)) {
    throw new Error('Envie uma foto JPEG, PNG ou WebP de até 8 MB.');
  }
}

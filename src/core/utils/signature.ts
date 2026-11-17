import sharp from 'sharp';
import { AppError } from '../errors/AppError.js';

export interface ProcessedSignature {
  originalBuffer: Buffer;
  thumbBuffer: Buffer;
}

/**
 * Valida que el Data URL / Base64 corresponda a un PNG real con trazos visibles
 * (no en blanco ni un toque accidental de 1 píxel) y genera versión optimizada + miniatura <= 20 KB.
 */
export async function validateAndProcessSignature(firmaBase64: string): Promise<ProcessedSignature> {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(firmaBase64.trim());
  if (!match || !match[1]) {
    throw new AppError(400, 'SIGNATURE_REQUIRED', 'La firma digital debe enviarse en formato PNG Base64 válido.');
  }

  const rawBuffer = Buffer.from(match[1], 'base64');
  if (rawBuffer.length === 0 || rawBuffer.length > 1_500_000) {
    throw new AppError(400, 'SIGNATURE_REQUIRED', 'El tamaño de la firma digital no es válido.');
  }

  let metadata: sharp.Metadata;
  let pixelData: { data: Buffer; info: sharp.OutputInfo };

  try {
    const image = sharp(rawBuffer);
    metadata = await image.metadata();
    if (metadata.format !== 'png' || !metadata.width || !metadata.height) {
      throw new Error('Formato inválido');
    }
    pixelData = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch {
    throw new AppError(400, 'SIGNATURE_REQUIRED', 'La imagen de firma está corrupta o no es un PNG válido.');
  }

  const totalPixels = pixelData.info.width * pixelData.info.height;
  const bytes = pixelData.data;
  let drawnPixels = 0;

  for (let i = 0; i < bytes.length; i += 4) {
    const r = bytes[i] ?? 255;
    const g = bytes[i + 1] ?? 255;
    const b = bytes[i + 2] ?? 255;
    const a = bytes[i + 3] ?? 0;

    // Píxel visible y no blanco
    if (a > 20 && (r < 245 || g < 245 || b < 245)) {
      drawnPixels += 1;
    }
  }

  const minPixels = Math.max(25, Math.floor(totalPixels * 0.0015));
  if (drawnPixels < minPixels) {
    throw new AppError(
      400,
      'SIGNATURE_REQUIRED',
      'Debe registrar una firma válida y legible antes de confirmar la entrega.',
    );
  }

  const originalBuffer = await sharp(rawBuffer)
    .png({ compressionLevel: 9 })
    .toBuffer();

  const thumbBuffer = await sharp(rawBuffer)
    .resize({ width: 300, height: 120, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9, palette: true, quality: 80 })
    .toBuffer();

  return { originalBuffer, thumbBuffer };
}


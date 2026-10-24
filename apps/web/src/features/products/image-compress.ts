/**
 * 发布 / 编辑商品前在浏览器里把大图压一下再传。
 * 后台服务器到闲鱼上传服务器是跨境链路，上行只有十几 KB/s，
 * 手机原图（2~5MB）动辄传几分钟甚至超时；压到长边 1600px 的 JPEG 一般只有 200~400KB，
 * 闲鱼商品图本身也会被压，肉眼看不出差别。
 * 任何一步失败都退回原图，不影响发布。
 */
export const COMPRESS_THRESHOLD_BYTES = 400 * 1024;
export const MAX_IMAGE_EDGE = 1600;
const COMPRESSIBLE = /^image\/(jpeg|jpg|png|webp|bmp)$/i;

export async function compressImageForUpload(file: File): Promise<File> {
  if (file.size <= COMPRESS_THRESHOLD_BYTES || !COMPRESSIBLE.test(file.type)) return file;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) { bitmap.close?.(); return file; }
    // JPEG 没有透明通道，透明 PNG 先铺白底。
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob || blob.size >= file.size) return file;
    const name = `${file.name.replace(/\.[^./\\]+$/, '') || 'image'}.jpg`;
    return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified });
  } catch {
    return file;
  }
}

export function compressImagesForUpload(files: File[]): Promise<File[]> {
  return Promise.all(files.map((file) => compressImageForUpload(file)));
}

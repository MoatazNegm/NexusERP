/**
 * Pre-rasterizes text (especially Arabic) into a PNG data URL using the
 * Canvas 2D fillText() API. Unlike html2canvas which parses and re-renders
 * glyphs individually (breaking Arabic ligatures), fillText() uses the
 * browser's native text shaping engine and correctly joins Arabic characters.
 *
 * Usage: call rasterizeText() in a useEffect, store the result in state,
 * then render an <img src={result} /> inside the PDF template.
 */

export interface RasterizeTextOptions {
  text: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  fontFamily?: string;
  lineHeight?: number;
  maxWidth?: number;
  direction?: 'rtl' | 'ltr';
  textAlign?: CanvasTextAlign;
}

/**
 * Rasterizes a single or multi-line text string into a high-res PNG data URL.
 * Returns '' if the text is empty.
 */
export const rasterizeText = (opts: RasterizeTextOptions): string => {
  const {
    text,
    fontSize,
    fontWeight,
    color,
    fontFamily = 'Arial, Tahoma, sans-serif',
    lineHeight = 1.6,
    maxWidth,
    direction = 'rtl',
    textAlign = 'right',
  } = opts;

  if (!text || !text.trim()) return '';

  const scale = 3; // High-DPI scale for crisp rendering
  const font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  const lineHeightPx = fontSize * lineHeight;
  const lines = text.split('\n').filter(l => l.trim());

  // Measure pass: determine canvas dimensions
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  if (!measureCtx) return '';

  measureCtx.font = font;
  let widestLine = 0;
  for (const line of lines) {
    const m = measureCtx.measureText(line);
    if (m.width > widestLine) widestLine = m.width;
  }

  const canvasWidth = Math.ceil((maxWidth || widestLine) + 20);
  const canvasHeight = Math.ceil(lines.length * lineHeightPx + fontSize * 0.5);

  // Render pass
  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth * scale;
  canvas.height = canvasHeight * scale;

  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  ctx.scale(scale, scale);

  // Transparent background (the PDF template already has a white bg)
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  ctx.direction = direction;
  ctx.textAlign = textAlign;

  const xPos = textAlign === 'right' ? canvasWidth - 10
    : textAlign === 'center' ? canvasWidth / 2
    : 10;

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], xPos, i * lineHeightPx + 2);
  }

  return canvas.toDataURL('image/png');
};

/**
 * Convenience: rasterize a company name + address block into two separate data URLs.
 * Returns { nameImg, addressImg }.
 */
export const rasterizeCompanyInfo = (
  companyName: string,
  companyAddress: string,
  options?: { nameColor?: string; addressColor?: string }
): { nameImg: string; addressImg: string } => {
  const nameImg = rasterizeText({
    text: companyName,
    fontSize: 18,
    fontWeight: 900,
    color: options?.nameColor || '#1e3a8a',
    direction: 'rtl',
    textAlign: 'right',
  });

  const addressImg = rasterizeText({
    text: companyAddress,
    fontSize: 12,
    fontWeight: 700,
    color: options?.addressColor || '#64748b',
    direction: 'rtl',
    textAlign: 'right',
    lineHeight: 1.6,
  });

  return { nameImg, addressImg };
};

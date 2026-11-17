const BOGOTA_TZ = 'America/Bogota';

function getBogotaParts(date: Date = new Date()): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: BOGOTA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') {
      parts[part.type] = part.value;
    }
  }
  if (parts.hour === '24') {
    parts.hour = '00';
  }
  return parts;
}

/** Retorna fecha actual en zona America/Bogota con formato YYYY-MM-DD. */
export function getBogotaDate(date: Date = new Date()): string {
  const p = getBogotaParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Retorna hora actual en zona America/Bogota con formato HH:mm:ss. */
export function getBogotaTime(date: Date = new Date()): string {
  const p = getBogotaParts(date);
  return `${p.hour}:${p.minute}:${p.second}`;
}

/** Retorna fecha y hora actual en zona America/Bogota con formato YYYY-MM-DD HH:mm:ss. */
export function getBogotaDateTime(date: Date = new Date()): string {
  return `${getBogotaDate(date)} ${getBogotaTime(date)}`;
}

/** Normaliza cédula eliminando puntos, comas, espacios y ceros a la izquierda innecesarios. */
export function normalizeCedula(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (/^\d+[.,]\d+e[+-]?\d+$/i.test(text)) {
    throw new Error(`Cédula en notación científica inválida: "${text}"`);
  }
  const cleaned = text.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
  return cleaned;
}

/** Parsea fechas de Excel (serial, Date o string YYYY-MM-DD / DD/MM/YYYY) en UTC puro sin desfase horario. */
export function parseExcelDateUTC(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    // Epoch de Excel (1899-12-30 UTC)
    const utcMs = Math.round((value - 25569) * 86400 * 1000);
    const dt = new Date(utcMs);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  const str = String(value).trim();
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(str);
  if (isoMatch && isoMatch[1] && isoMatch[2] && isoMatch[3]) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
  }

  const latamMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(str);
  if (latamMatch && latamMatch[1] && latamMatch[2] && latamMatch[3]) {
    return `${latamMatch[3]}-${latamMatch[2].padStart(2, '0')}-${latamMatch[1].padStart(2, '0')}`;
  }

  return null;
}


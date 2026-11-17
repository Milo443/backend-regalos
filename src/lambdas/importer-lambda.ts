import { processExcelImport, type ImportProcessInput } from '../modules/importaciones/importaciones.service.js';

export interface ImporterEvent {
  actividad_id: number;
  s3_key: string;
  nombre_archivo: string;
  usuario_id: number;
}

export async function handler(event: ImporterEvent) {
  const input: ImportProcessInput = {
    actividad_id: event.actividad_id,
    s3_key: event.s3_key,
    nombre_archivo: event.nombre_archivo,
    usuario_id: event.usuario_id,
    forensic: {
      ip_origen: 'lambda-importer',
      user_agent: 'aws-lambda',
    },
  };

  return processExcelImport(input);
}


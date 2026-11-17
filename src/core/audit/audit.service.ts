import { DbExecutor, executeSql, pool } from '../database/mysql.js';

export interface ForensicContext {
  ip_origen: string;
  user_agent: string;
}

export interface AuditLogInput {
  usuario_id: number | null;
  accion: string;
  tabla_afectada?: string | null;
  registro_id?: number | null;
  detalle_operacion?: Record<string, unknown> | string | null;
  forensic: ForensicContext;
}

export interface AsociadoAuditFieldInput {
  asociado_id: number;
  usuario_id: number;
  rol_usuario: 'SUPER_ADMIN' | 'ADMINISTRADOR';
  accion: 'CREACION' | 'MODIF_PARCIAL' | 'EDICION_MAESTRA';
  campo_modificado: string;
  valor_anterior: string | null;
  valor_nuevo: string | null;
  motivo?: string | null;
  ip_origen: string;
}

export async function logGlobalAudit(
  input: AuditLogInput,
  executor: DbExecutor = pool,
): Promise<void> {
  const detalle =
    input.detalle_operacion === undefined || input.detalle_operacion === null
      ? null
      : typeof input.detalle_operacion === 'string'
        ? input.detalle_operacion
        : JSON.stringify(input.detalle_operacion);

  await executeSql(
    `INSERT INTO auditoria_logs (usuario_id, accion, tabla_afectada, registro_id, detalle_operacion, ip_origen, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.usuario_id,
      input.accion,
      input.tabla_afectada ?? null,
      input.registro_id ?? null,
      detalle,
      input.forensic.ip_origen,
      input.forensic.user_agent,
    ],
    executor,
  );
}

export async function logAsociadoFieldChange(
  input: AsociadoAuditFieldInput,
  executor: DbExecutor = pool,
): Promise<void> {
  await executeSql(
    `INSERT INTO asociados_auditoria
      (asociado_id, usuario_id, rol_usuario, accion, campo_modificado, valor_anterior, valor_nuevo, motivo, ip_origen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.asociado_id,
      input.usuario_id,
      input.rol_usuario,
      input.accion,
      input.campo_modificado,
      input.valor_anterior,
      input.valor_nuevo,
      input.motivo ?? null,
      input.ip_origen,
    ],
    executor,
  );
}


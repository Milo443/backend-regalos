import nodemailer from 'nodemailer';
import { env } from '../../core/config/env.js';
import type { EmailQueueMessage } from '../../core/queue/QueueProvider.js';

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (!env.SMTP_PASS) {
    return null;
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
    });
  }
  return transporter;
}

export async function sendDeliveryReceiptEmail(msg: EmailQueueMessage): Promise<void> {
  const client = getTransporter();
  if (!client) {
    console.info(
      `[EmailFallback] Sin SMTP_PASS configurado. Acuse simulado para ${msg.asociado_email} (Entrega #${msg.entrega_id}).`,
    );
    return;
  }

  await client.sendMail({
    from: env.SMTP_FROM,
    to: msg.asociado_email,
    subject: `CEMCOP · Comprobante de entrega: ${msg.actividad_titulo}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; color: #1f2937;">
        <h2 style="color: #0f766e;">CEMCOP · Acuse de Entrega de Obsequio</h2>
        <p>Estimado(a) <strong>${msg.asociado_nombre}</strong>,</p>
        <p>Confirmamos que se ha registrado exitosamente la entrega correspondiente a la campaña <strong>${msg.actividad_titulo}</strong>.</p>
        <ul>
          <li><strong>Nro. Registro:</strong> #${msg.entrega_id}</li>
          <li><strong>Fecha y hora:</strong> ${msg.fecha_entrega} ${msg.hora_entrega}</li>
          <li><strong>Sede de atención:</strong> ${msg.sede_nombre}</li>
        </ul>
        <p style="font-size: 12px; color: #6b7280;">Este es un mensaje automático de CEMCOP. Por favor no responder a este correo.</p>
      </div>
    `,
  });
}


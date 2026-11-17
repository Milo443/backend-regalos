import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { env } from '../config/env.js';

export interface ReportQueueMessage {
  job_id: string;
  actividad_id: number;
  tipo: 'COMPLETO' | 'DIARIO';
  fecha?: string;
}

export interface EmailQueueMessage {
  entrega_id: number;
  asociado_nombre: string;
  asociado_email: string;
  actividad_titulo: string;
  fecha_entrega: string;
  hora_entrega: string;
  sede_nombre: string;
}

class QueueProvider {
  private readonly sqs: SQSClient | null;

  constructor() {
    this.sqs =
      env.SQS_REPORTS_QUEUE_URL || env.SQS_EMAIL_QUEUE_URL
        ? new SQSClient({ region: env.AWS_REGION })
        : null;
  }

  async publishReportJob(
    payload: ReportQueueMessage,
    inProcessFallback?: (msg: ReportQueueMessage) => Promise<void>,
  ): Promise<void> {
    if (this.sqs && env.SQS_REPORTS_QUEUE_URL) {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: env.SQS_REPORTS_QUEUE_URL,
          MessageBody: JSON.stringify(payload),
        }),
      );
      return;
    }

    if (inProcessFallback) {
      setImmediate(() => {
        inProcessFallback(payload).catch((err) => {
          console.error('[QueueFallback] Error generando reporte:', err);
        });
      });
    }
  }

  async publishEmailNotification(
    payload: EmailQueueMessage,
    inProcessFallback?: (msg: EmailQueueMessage) => Promise<void>,
  ): Promise<void> {
    if (this.sqs && env.SQS_EMAIL_QUEUE_URL) {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: env.SQS_EMAIL_QUEUE_URL,
          MessageBody: JSON.stringify(payload),
        }),
      );
      return;
    }

    if (inProcessFallback) {
      setImmediate(() => {
        inProcessFallback(payload).catch((err) => {
          console.error('[QueueFallback] Error enviando correo:', err);
        });
      });
    }
  }
}

export const queueProvider = new QueueProvider();


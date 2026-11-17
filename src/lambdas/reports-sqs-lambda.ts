import type { ReportQueueMessage } from '../core/queue/QueueProvider.js';
import { generateExcelReportJob } from '../modules/reportes/reportes.service.js';

interface SQSRecord {
  messageId: string;
  body: string;
}

interface SQSEvent {
  Records: SQSRecord[];
}

export async function handler(event: SQSEvent) {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];

  for (const record of event.Records) {
    try {
      const payload = JSON.parse(record.body) as ReportQueueMessage;
      await generateExcelReportJob(payload);
    } catch (err) {
      console.error(`[ReportsSQS] Error procesando mensaje ${record.messageId}:`, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}


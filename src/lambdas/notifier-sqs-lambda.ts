import type { EmailQueueMessage } from '../core/queue/QueueProvider.js';
import { sendDeliveryReceiptEmail } from '../modules/entregas/notifier.service.js';

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
      const payload = JSON.parse(record.body) as EmailQueueMessage;
      await sendDeliveryReceiptEmail(payload);
    } catch (err) {
      console.error(`[NotifierSQS] Error enviando correo ${record.messageId}:`, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}


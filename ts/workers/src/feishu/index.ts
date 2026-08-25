/**
 * Feishu (Lark) worker — bridges the niq event bus to Feishu.
 *
 * The worker subscribes to events of a configurable type (default `feishu.send`)
 * and, for each, delivers the message payload to Feishu through a sender
 * function. Delivery results are published back as `feishu.delivered` /
 * `feishu.failed` events so other workers can react.
 *
 * The actual Feishu API integration is injected via {@link FeishuSender} so the
 * worker can be tested without real credentials.
 */
import {
  EventType,
  HTTPWorkerClient,
  createEvent,
  type Event,
  type HTTPWorkerClientOptions,
} from "@niq.run/worker-sdk";

/** Delivers one message payload to Feishu. Return the outbound message id. */
export type FeishuSender = (payload: Record<string, unknown>) => Promise<string>;

export interface FeishuWorkerOptions extends HTTPWorkerClientOptions {
  /** Event type that triggers a Feishu send. Defaults to `feishu.send`. */
  sendEventType?: string;
  /** Event type published on successful delivery. Defaults to `feishu.delivered`. */
  deliveredEventType?: string;
  /** Event type published when delivery fails. Defaults to `feishu.failed`. */
  failedEventType?: string;
  /** Delivers a payload to Feishu. Required — supply a real integration. */
  sender: FeishuSender;
}

export class FeishuWorker {
  private readonly client: HTTPWorkerClient;
  private readonly opts: FeishuWorkerOptions;

  constructor(opts: FeishuWorkerOptions) {
    this.client = new HTTPWorkerClient(opts);
    this.opts = opts;
  }

  async run(): Promise<void> {
    await this.client.connect();
    await this.client.broadcast(
      createEvent(EventType.WorkerReady, { worker: "feishu" }),
    );

    const sendType = this.opts.sendEventType ?? "feishu.send";
    for await (const event of this.client.events()) {
      if (event.type !== sendType) continue;
      await this.handleSend(event);
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private async handleSend(event: Event): Promise<void> {
    const deliveredType = this.opts.deliveredEventType ?? "feishu.delivered";
    const failedType = this.opts.failedEventType ?? "feishu.failed";
    try {
      const messageId = await this.opts.sender(event.payload);
      await this.client.broadcast(
        createEvent(deliveredType, {
          ref: event.id,
          message_id: messageId,
        }),
      );
    } catch (err) {
      await this.client.broadcast(
        createEvent(failedType, {
          ref: event.id,
          error: (err as Error).message,
        }),
      );
    }
  }
}

import { createTransport, type Transporter } from "nodemailer";
import type { WorkerConfig } from "../common/config/worker-config.js";

export interface OutgoingMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** A failed delivery; permanent failures (SMTP 5xx) are not retried automatically. */
export class DeliveryError extends Error {
  override readonly name = "DeliveryError";

  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

/** Replaceable delivery adapter: SMTP to the captured inbox, or a controlled failure in isolated environments. */
export abstract class MailTransport {
  abstract send(mail: OutgoingMail): Promise<void>;
}

export class SmtpTransport extends MailTransport {
  private readonly transporter: Transporter;

  constructor(private readonly config: WorkerConfig) {
    super();
    this.transporter = createTransport({
      host: config.smtpUrl.hostname,
      port: Number(config.smtpUrl.port || 25),
      secure: false,
      ignoreTLS: true,
      connectionTimeout: config.sendTimeoutMs,
      greetingTimeout: config.sendTimeoutMs,
      socketTimeout: config.sendTimeoutMs,
    });
  }

  async send(mail: OutgoingMail): Promise<void> {
    try {
      await this.transporter.sendMail({ from: this.config.from, to: mail.to, subject: mail.subject, text: mail.text, headers: { ...mail.headers } });
    } catch (error: unknown) {
      const responseCode = typeof error === "object" && error !== null && "responseCode" in error ? Number(error.responseCode) : NaN;
      const message = error instanceof Error ? error.message : String(error);
      throw new DeliveryError(message, responseCode >= 500 && responseCode < 600);
    }
  }
}

export class FailingTransport extends MailTransport {
  constructor(private readonly mode: "transient" | "permanent") {
    super();
  }

  send(): Promise<void> {
    return Promise.reject(
      new DeliveryError(`Controlled ${this.mode} delivery failure (NOTIFICATION_FAILURE_MODE=${this.mode}).`, this.mode === "permanent"),
    );
  }
}

import { Injectable } from "@nestjs/common";

/** Injection token and contract for the application clock; swap it to control time in tests. */
export abstract class Clock {
  abstract now(): Date;
}

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

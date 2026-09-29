import { Injectable } from "@nestjs/common";
import { hash, verify } from "@node-rs/argon2";

// OWASP-recommended argon2id parameters (argon2id is the library default algorithm).
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordHasher {
  private dummyHash: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  verify(passwordHash: string, password: string): Promise<boolean> {
    return verify(passwordHash, password);
  }

  /** Spends the same work as a real check so response time does not reveal unknown accounts. */
  async verifyAgainstDummy(password: string): Promise<false> {
    this.dummyHash ??= hash("dummy-password-for-timing", ARGON2_OPTIONS);
    await verify(await this.dummyHash, password);
    return false;
  }
}

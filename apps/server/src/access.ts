/**
 * Access control (web plan §2).
 *
 * Privacy is enforced at the deployment boundary, not per user: the site is
 * unlisted, and a single shared secret in the URL is the whole gate. With no
 * accounts, everyone who reaches the site sees everything on it — which is
 * acceptable because everyone who reaches it was given the link.
 *
 * Bot source never reaches this server at all (web plan §3), so "bot source is
 * private" is structural rather than a permission check.
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

export function configuredKey(): string {
  return process.env['SPARK_KEY'] ?? '';
}

export function keyMatches(supplied: string | undefined): boolean {
  const expected = configuredKey();
  // No key configured means LAN or Tailscale deployment: the network is the gate.
  if (expected === '') return true;
  return typeof supplied === 'string' && supplied === expected;
}

@Injectable()
export class AccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const supplied =
      (typeof req.query['key'] === 'string' ? req.query['key'] : undefined) ??
      (typeof req.headers['x-spark-key'] === 'string' ? req.headers['x-spark-key'] : undefined);
    if (!keyMatches(supplied)) throw new UnauthorizedException('bad or missing access key');
    return true;
  }
}

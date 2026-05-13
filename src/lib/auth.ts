// src/lib/auth.ts
import jwt from "jsonwebtoken";
import { NextRequest, NextResponse } from "next/server";

export interface JwtClaims {
  sub: string; // user id
  email: string;
  role: "USER" | "ADMIN";
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new AuthError("Server misconfigured: JWT_SECRET is not set", 500);
  }
  return secret;
}

export function signToken(payload: JwtClaims): string {
  return jwt.sign(payload, getSecret(), { expiresIn: "1h" });
}

export function verifyToken(token: string): JwtClaims {
  return jwt.verify(token, getSecret()) as JwtClaims;
}

export function verifyBearer(authorization?: string | null): JwtClaims {
  if (!authorization) throw new AuthError("Missing Authorization header", 401);
  const [type, token] = authorization.split(" ");
  if (type !== "Bearer" || !token) throw new AuthError("Invalid Authorization header", 401);
  try {
    return verifyToken(token);
  } catch (e) {
    if (e instanceof AuthError) throw e;
    throw new AuthError("Invalid or expired token", 401);
  }
}

/**
 * Verify the request's bearer token and return the decoded claims.
 * Throws AuthError with .status for the route handler to convert into a response.
 */
export function requireAuth(req: NextRequest): JwtClaims {
  return verifyBearer(req.headers.get("authorization"));
}

/**
 * Convert any thrown error into a JSON response. AuthError keeps its status;
 * everything else becomes a 500 with a generic message.
 */
export function errorResponse(error: unknown, fallback = "Internal server error"): NextResponse {
  if (error instanceof AuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcrypt';

import { prisma } from '@/lib/prisma';
import { signToken, errorResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';

    if (!email || !password) {
      return NextResponse.json({ message: 'Email and password are required' }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return NextResponse.json({ message: 'Invalid credentials' }, { status: 401 });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return NextResponse.json({ message: 'Invalid credentials' }, { status: 401 });

    const accessToken = signToken({
      sub: user.id,
      email: user.email,
      role: user.role as 'USER' | 'ADMIN',
    });
    return NextResponse.json({ accessToken, email: user.email }, { status: 200 });
  } catch (error) {
    return errorResponse(error, 'Login failed');
  }
}

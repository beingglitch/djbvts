import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcrypt';

import { prisma } from '@/lib/prisma';
import { errorResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const DEVELOPER_CODE = process.env.DEVELOPER_SIGNUP_CODE || 'DEV2025DJBVTS';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const name = typeof body?.name === 'string' ? body.name.trim() || null : null;
    const developerCode = typeof body?.developerCode === 'string' ? body.developerCode : '';

    if (!email || !password) {
      return NextResponse.json({ message: 'Email and password are required' }, { status: 400 });
    }

    if (password.length < 8) {
      return NextResponse.json({ message: 'Password must be at least 8 characters' }, { status: 400 });
    }

    if (!developerCode) {
      return NextResponse.json({ message: 'Developer code is required' }, { status: 400 });
    }

    if (developerCode !== DEVELOPER_CODE) {
      return NextResponse.json({ message: 'Invalid developer code' }, { status: 403 });
    }

    const hash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({ data: { email, password: hash, name } });
    return NextResponse.json({ id: user.id, email: user.email }, { status: 201 });
  } catch (e: any) {
    if (e?.code === 'P2002') {
      return NextResponse.json({ message: 'Email already exists' }, { status: 409 });
    }
    return errorResponse(e, 'Signup failed');
  }
}

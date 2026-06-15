import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';

export async function GET() {
  const path = process.env.TOKSCALE_LOCAL_DATA_PATH;

  if (!path) {
    return NextResponse.json({ error: 'Local data is not configured' }, { status: 404 });
  }

  try {
    const raw = await readFile(path, 'utf8');
    return new NextResponse(raw, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

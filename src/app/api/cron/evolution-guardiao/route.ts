import { NextResponse } from 'next/server'

// GUARDIÃO DO EVOLUTION — DESATIVADO PERMANENTEMENTE (2026-08-21).
//
// A escola migrou para a WhatsApp Cloud API oficial em Coexistência (CoEx).
// Neste modelo, reiniciar/reconectar o Evolution FAZ o número ser reclamado pela
// sessão do Evolution e PERDER o registro na Cloud (erro 133010 "Account not
// registered") — foi exatamente o que derrubou o atendimento em 20/08.
//
// Por isso esta rota virou um no-op: NÃO chama o Railway, NÃO reinicia nada, NÃO
// consulta a instância. Também foi removida do vercel.json. Mantida só como
// endpoint inerte para não quebrar chamadas antigas.
//
// Para religar o Evolution (não recomendado enquanto o número estiver em CoEx),
// recupere esta rota do histórico do git.

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({
    ok: true,
    desativado: true,
    motivo: 'Guardião do Evolution desativado — número em WhatsApp Cloud API (Coexistência). Reiniciar o Evolution desregistra o número da Cloud.',
  })
}

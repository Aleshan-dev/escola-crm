export const metadata = { title: 'Política de Privacidade — CRM SARA' }

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-slate-800">
      <h1 className="mb-2 text-2xl font-bold">Política de Privacidade — CRM SARA</h1>
      <p className="mb-6 text-sm text-slate-500">Última atualização: junho de 2026</p>

      <section className="space-y-4 text-sm leading-relaxed">
        <p>O CRM SARA é uma plataforma de gestão de relacionamento para escolas, que integra um
        assistente de atendimento via WhatsApp. Esta política descreve como tratamos os dados.</p>

        <h2 className="pt-2 text-lg font-semibold">Dados que coletamos</h2>
        <p>Nome e telefone de responsáveis/interessados, conteúdo das conversas de WhatsApp
        trocadas com a escola, e informações fornecidas durante o atendimento (ex.: série de
        interesse, agendamento de visita).</p>

        <h2 className="pt-2 text-lg font-semibold">Como usamos</h2>
        <p>Para responder mensagens, organizar o funil de matrículas da escola, agendar visitas e
        melhorar o atendimento. As mensagens são processadas pela API oficial do WhatsApp (Meta) e
        por modelos de IA para gerar respostas.</p>

        <h2 className="pt-2 text-lg font-semibold">Compartilhamento</h2>
        <p>Não vendemos dados. Compartilhamos apenas com provedores necessários à operação:
        WhatsApp/Meta (envio e recebimento de mensagens), provedor de IA (geração de respostas) e
        infraestrutura de hospedagem e banco de dados.</p>

        <h2 className="pt-2 text-lg font-semibold">Retenção e direitos</h2>
        <p>Mantemos os dados enquanto necessários ao atendimento. Conforme a LGPD, o titular pode
        solicitar acesso, correção ou exclusão dos seus dados a qualquer momento.</p>

        <h2 className="pt-2 text-lg font-semibold">Contato</h2>
        <p>Dúvidas sobre privacidade: aleshan87@gmail.com.</p>
      </section>
    </main>
  )
}

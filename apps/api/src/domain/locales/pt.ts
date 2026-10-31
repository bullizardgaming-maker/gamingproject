import { simpleDuration, type LocalePack } from './types.js';

const U = { minute: 'minuto', minutes: 'minutos', hour: 'hora', hours: 'horas' };

/** Português (Brasil). */
const pt: LocalePack = {
  layout: { greeting: "Olá, {name},", greetingNoName: "Olá,", signoff: "Bullizard Team", why: "Você recebe este e-mail porque tem uma conta na Bullizard.", safety: "Nunca pedimos sua senha ou seus códigos por e-mail.", manage: "Configurações de e-mail", legal: "Bullizard · 18+ only · Somente maiores de 18 · Sem vínculo com editoras de jogos", button: "Abrir a Bullizard" },
  verifySubject: (code) => `Seu código da Bullizard: ${code}`,
  verifyCode: (code, minutes) => `Seu código é ${code}. Ele vale por ${simpleDuration(minutes, U)}. Se você não pediu, ignore este e-mail.`,
  duration: (minutes) => simpleDuration(minutes, U),
  withdrawalReasons: { unsupported_coin: "Os saques são enviados só em USDT. Adicione um endereço USDT (TRC-20 ou BEP-20) e tente de novo.", not_approved: "Ele não foi aprovado. Fale com o suporte se precisar dos detalhes.", provider_failed: "A rede de pagamento recusou. Confira seu endereço e tente de novo." },
  templates: {
    protection_ending: {
      subject: (d) => `Faltam 24 horas para conferir ${d.title}`,
      body: (d, link, h) => `O vendedor recebe automaticamente em ${h.when(d.protection_ends_at)}. Se algo estiver errado com seu pedido, abra uma disputa antes disso.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    dispute_statement: {
      subject: () => 'Nova declaração na sua disputa',
      body: (d, link) => `O ${d.role === 'buyer' ? 'comprador' : 'vendedor'} adicionou uma declaração à disputa. Leia e responda no chat do pedido ou com a sua própria declaração antes de o árbitro decidir.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    warranty_claim: {
      subject: (d) => `Reclamação de garantia em ${d.title}`,
      body: (d, link) => {
        const r = ({ recovered: "o dono original recuperou a conta", banned: "a conta foi banida", locked: "a conta está bloqueada" } as Record<string, string>)[d.reason as string] ?? "a conta parou de funcionar";
        return `O comprador diz que ${r}. Você tem ${d.hours} horas para corrigir, reembolsar ou contestar; depois um árbitro decide. O pagamento deste pedido fica retido até a reclamação ser resolvida.\n\n${link(`/orders/${d.order_id}`)}`;
      },
    },
    warranty_update: {
      subject: (d) => `Atualização da reclamação de garantia: ${d.title}`,
      body: (d, link) => {
        const b = d.role === 'buyer';
        const m: Record<string, string> = { seller_fixed: b ? "O vendedor diz que a conta voltou a funcionar. Confirme, ou envie a reclamação a um árbitro se não funcionar." : "Você informou uma correção. O comprador tem 72 horas para confirmar.", escalated: "A reclamação foi para um árbitro, que vai ler o chat do pedido e decidir.", resolved: "Reclamação resolvida: a conta voltou a funcionar.", refunded: b ? "Você foi reembolsado pela garantia." : "O comprador foi reembolsado pela garantia, com o pagamento retido deste pedido.", rejected: "Um árbitro rejeitou a reclamação.", withdrawn: "O comprador retirou a reclamação." };
        return `${m[d.status as string] ?? "A reclamação foi atualizada."}\n\n${link(`/orders/${d.order_id}`)}`;
      },
    },
    order_progress: {
      subject: (d) => `${d.percent}% concluído: ${d.title}`,
      body: (d, link) => `O vendedor publicou o progresso de “${d.title}”: ${d.percent}%${d.note ? `. “${d.note}”` : '.'}\n\n${link(`/orders/${d.order_id}`)}`,
    },
    chargeback_received: {
      subject: (d) => `Chargeback no pedido ${String(d.order_id).slice(0, 8)}`,
      body: (d, _link, h) =>
        `O banco do comprador estornou ${h.money(d.amount_cents)} (${d.network} ${d.reason_code}). Enviamos as provas automaticamente.\n\n` +
        (d.seller_protected ? 'A proteção contra chargeback cobre este pedido: seu saldo não é afetado.' : 'Este anúncio não tinha prova verificada de dono original, então o valor foi descontado do seu saldo. Se o banco decidir a nosso favor, ele é devolvido.'),
    },
    new_signin: {
      subject: () => 'Novo acesso à sua conta Bullizard',
      body: (d, link, h) => `Sua conta foi acessada de um novo dispositivo (${d.userAgent ?? 'navegador desconhecido'}, IP ${d.ip ?? 'desconhecido'}) em ${h.when(d.at)}.\n\nNão foi você? Troque a senha e desconecte os outros dispositivos: ${link('/account')}`,
    },
    password_reset: {
      subject: () => 'Redefina sua senha da Bullizard',
      body: (d) =>
        `Alguém pediu para redefinir a senha desta conta${d.ip ? ` (do IP ${d.ip})` : ''}. Use este link em até ${d.minutes} minutos:\n\n${d.url}\n\n` +
        `Se não foi você, ignore este e-mail; sua senha continua a mesma.`,
    },
    new_review: {
      subject: (d) => `Nova avaliação de ${d.rating} estrelas`,
      body: (d, link) => `Um comprador avaliou o pedido “${d.title}” com ${d.rating}/5${d.comment ? `: “${d.comment}”` : '.'}\n\nVocê pode publicar uma resposta pública: ${link('/sell')}`,
    },
    password_changed: {
      subject: () => 'Sua senha foi alterada',
      body: (_d, link) => `Sua senha foi alterada e seus outros dispositivos foram desconectados. Não foi você? Redefina a senha imediatamente: ${link('/account')}`,
    },
    mfa_changed: {
      subject: (d) => (d.enabled ? 'Verificação em duas etapas ativada' : 'Verificação em duas etapas desativada'),
      body: (d, link) => `A verificação em duas etapas foi ${d.enabled ? 'ativada' : 'desativada'} na sua conta e os outros dispositivos foram desconectados. Não foi você? ${link('/account')}`,
    },
    session_reuse_detected: {
      subject: () => 'Desconectamos um dispositivo que pode estar comprometido',
      body: (d, link) => `Um token de acesso de um dos seus dispositivos (${d.userAgent ?? 'navegador desconhecido'}) foi usado duas vezes, o que geralmente indica que foi copiado. Desconectamos esse dispositivo. Troque a senha se não esperava por isso: ${link('/account')}`,
    },
    clawback: {
      subject: (d) => `Reembolso após liberação: ${d.title}`,
      body: (d, link, h) =>
        `Após analisar o pedido “${d.title}”, reembolsamos o comprador (${d.reason}). Sua parte, ${h.money(d.amount_cents, d.currency)}, foi descontada do seu saldo; se ele ficar negativo, o valor é recuperado das próximas vendas. A comissão também foi devolvida (nota de crédito ${d.credit_note}).\n\n${link(`/orders/${d.order_id}`)}`,
    },
    withdrawal_failed: {
      subject: (d, h) => `Saque de ${h.money(d.amount_cents, d.currency)} não enviado`,
      body: (d, link, h) => `Não conseguimos enviar seu saque de ${h.money(d.amount_cents, d.currency)}. ${h.reason(d.reason)} O dinheiro voltou para o seu saldo.

Abrir carteira: ${link('/sell/money')}`,
    },
    invoice_issued: {
      subject: (d) => `Sua fatura de comissão ${d.number}`,
      body: (d, link, h) => `A fatura ${d.number} de ${d.period} está pronta: comissão de ${h.money(d.gross_cents, d.currency)}, sendo ${h.money(d.tax_cents, d.currency)} de imposto. Ela já foi descontada das suas vendas.\n\n${link('/sell/invoices')}`,
    },
    debt_reminder: {
      subject: (d, h) => (d.first ? `Seu saldo está em ${h.money(-d.amount_cents, d.currency)}` : `Lembrete: você deve ${h.money(d.amount_cents, d.currency)}`),
      body: (d, link, h) =>
        `Seu saldo na Bullizard está ${h.money(d.amount_cents, d.currency)} negativo após um reembolso ou chargeback. Novas vendas cobrem o valor automaticamente, ou você pode pagar agora no cartão. ` +
        `Os saques ficam pausados até a quitação, e se ainda estiver em aberto em ${h.when(d.pause_at)}, sua loja será pausada.\n\n${link('/sell/money')}`,
    },
    debt_shop_paused: {
      subject: () => 'Sua loja está pausada até o saldo ser quitado',
      body: (d, link, h) =>
        `Seu saldo continua ${h.money(d.amount_cents, d.currency)} negativo, então seus anúncios estão ocultos e não podem ser comprados. Pedidos já pagos ainda precisam ser entregues. ` +
        `Quite o saldo para reabrir a loja na hora.\n\n${link('/sell/money')}`,
    },
    debt_cleared: {
      subject: () => 'Seu saldo foi regularizado',
      body: (d, link) => `Seu saldo em ${d.currency} voltou a ficar positivo${d.reason === 'written_off' ? ' (perdoamos o restante)' : ''}. ${d.resumed ? 'Sua loja está aberta de novo. ' : ''}Os saques funcionam normalmente.\n\n${link('/sell/money')}`,
    },
    watch_price_drop: {
      subject: (d, h) => `Queda de preço: ${d.title} agora por ${h.money(d.price_cents, d.currency)}`,
      body: (d, link, h) =>
        `${d.title} agora custa ${h.money(d.price_cents, d.currency)}${d.target_cents ? `, no seu preço-alvo de ${h.money(d.target_cents, d.currency)} ou abaixo` : ', menos do que quando você começou a acompanhar'}.\n\n${link(`/offers/${d.offer_id}`)}`,
    },
    watch_back_in_stock: {
      subject: (d) => `De volta ao estoque: ${d.title}`,
      body: (d, link, h) => `${d.title} está disponível novamente por ${h.money(d.price_cents, d.currency)}.\n\n${link(`/offers/${d.offer_id}`)}`,
    },
    watch_game_low: {
      subject: (d, h) => `${d.game}${d.attributes && Object.keys(d.attributes).length ? ` (${Object.values(d.attributes).join(', ')})` : ''}: a partir de ${h.money(d.price_cents, d.currency)}`,
      body: (d, link, h) =>
        `Um anúncio de ${d.game} que você acompanha está ${d.target_cents ? `no seu preço-alvo de ${h.money(d.target_cents, d.currency)} ou abaixo` : 'em um novo preço mais baixo'}: “${d.title}” por ${h.money(d.price_cents, d.currency)}.\n\n${link(`/offers/${d.offer_id}`)}`,
    },
    request_posted: {
      subject: (d) => `Novo pedido em ${d.game}: ${d.title}`,
      body: (d, link, h) => `Um comprador procura “${d.title}”${d.budget_cents ? ` com orçamento de ${h.money(d.budget_cents, d.currency)}` : ''}. Você vende em ${d.game}, então pode ter o que ele precisa. Envie um preço e um prazo de entrega.\n\n${link(`/requests/${d.request_id}`)}`,
    },
    request_proposal: {
      subject: (d) => `${d.revised ? 'Proposta atualizada' : 'Nova proposta'} para “${d.title}”`,
      body: (d, link, h) => `${d.seller_name} oferece ${h.money(d.price_cents, d.currency)} com entrega em até ${d.delivery_hours} horas. Aceite para pagar; seu pagamento fica em custódia como em qualquer pedido.\n\n${link(`/requests/${d.request_id}`)}`,
    },
    request_accepted: {
      subject: (d) => `Proposta aceita: ${d.title}`,
      body: (d, link, h) => `O comprador aceitou sua proposta de ${h.money(d.price_cents, d.currency)}. Criamos um anúncio privado para ele; você recebe o aviso de novo pedido assim que ele pagar.\n\n${link(`/requests/${d.request_id}`)}`,
    },
    listing_review: {
      subject: () => 'Seu anúncio está em análise',
      body: (d, link) => `${d.title ? `“${d.title}”` : 'Seu anúncio'} menciona algo que nossas regras pedem para verificar (itens proibidos ou dados de contato), então ele fica oculto até um moderador analisar, geralmente em poucas horas. Você será avisado em qualquer caso.\n\n${link('/sell')}`,
    },
    listing_approved: {
      subject: (d) => `Anúncio aprovado: ${d.title}`,
      body: (d, link) => `Um moderador aprovou “${d.title}” e ele está no ar de novo.\n\n${link(`/offers/${d.offer_id}`)}`,
    },
    listing_rejected: {
      subject: (d) => `Anúncio removido: ${d.title}`,
      body: (d, link) => `Um moderador removeu “${d.title}”: ${d.note}\n\nVocê pode publicar um novo anúncio que siga as regras. Fale com o suporte se achar que foi um engano.\n\n${link('/support/new?category=selling')}`,
    },
    support_received: {
      subject: (d) => `Recebemos sua solicitação nº ${d.number}`,
      body: (d, link) => `Obrigado por falar com a gente sobre “${d.subject}”. Nosso suporte costuma responder em poucas horas; você receberá um e-mail quando responderem.\n\n${link(`/support/${d.ticket_id}`)}`,
    },
    support_reply: {
      subject: (d) => (d.resolved ? `Solicitação nº ${d.number} resolvida` : `Nova resposta na solicitação nº ${d.number}`),
      body: (d, link) =>
        `O suporte da Bullizard respondeu a “${d.subject}”${d.resolved ? ' e marcou como resolvida. Responda se ainda precisar de ajuda e ela será reaberta' : ''}:\n\n${d.preview}\n\n${link(`/support/${d.ticket_id}`)}`,
    },
    support_auto_resolved: {
      subject: (d) => `Solicitação nº ${d.number} encerrada`,
      body: (d, link) => `Não tivemos retorno sobre “${d.subject}” há ${d.days} dias, então marcamos como resolvida. Responda quando quiser para reabrir.\n\n${link(`/support/${d.ticket_id}`)}`,
    },
    account_locked: {
      subject: () => 'Login pausado após tentativas malsucedidas',
      body: (d, link, h) => `Alguém tentou entrar na sua conta e errou a senha ${d.failures} vezes, então o login está pausado por ${h.duration(Number(d.minutes))}. Se foi você, espere ou redefina sua senha. Se não foi, sua conta continua segura. Ative a verificação em duas etapas para continuar assim.

Redefinir senha: ${link('/forgot-password')}`,
    },
  },
};
export default pt;

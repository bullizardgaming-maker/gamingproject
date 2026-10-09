import type { LocalePack } from './types.js';

/** Português (Brasil). */
const pt: LocalePack = {
  signoff: '— Equipe Bullizard',
  manage: 'Gerenciar e-mails',
  verifyCode: (code, minutes) => `Seu código de verificação é ${code}. Ele expira em ${minutes} minutos.`,
  templates: {
    order_paid: {
      subject: (d) => `Pagamento recebido por ${d.title}`,
      body: (d, link, h) => `Recebemos ${h.money(d.amount_cents, d.currency)} por “${d.title}”. O valor fica em custódia e o vendedor só recebe quando você tiver o produto.\n\nAcompanhe o pedido: ${link(`/orders/${d.order_id}`)}`,
    },
    order_delivered: {
      subject: (d) => `Entregue: ${d.title}`,
      body: (d, link, h) =>
        `Seu pedido “${d.title}” foi entregue. Abra a página do pedido para ver.\n\n` +
        (d.protection === 'insurance_14d'
          ? `Esta conta tem seguro de 14 dias até ${h.when(d.protection_ends_at)}. Complete agora o checklist de segurança: troque a senha, o e-mail de recuperação e o 2FA.`
          : `Você tem até ${h.when(d.protection_ends_at)} para conferir. Se algo estiver errado, abra uma disputa antes disso.`) +
        `\n\n${link(`/orders/${d.order_id}`)}`,
    },
    order_refunded: {
      subject: (d) => `Reembolso de ${d.title}`,
      body: (d, link, h) => `${h.money(d.amount_cents, d.currency)} foram devolvidos ao seu meio de pagamento original. Reembolsos no cartão costumam aparecer em 5 a 10 dias úteis.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    delivery_late: {
      subject: (d) => `Seu pedido está atrasado: ${d.title}`,
      body: (d, link, h) =>
        `O vendedor prometeu entregar até ${h.when(d.delivery_due_at)} e ainda não entregou. Você pode esperar ou cancelar agora com reembolso total. ` +
        `Se não for entregue em ${d.auto_refund_hours} horas, reembolsamos automaticamente.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    delivery_overdue: {
      subject: (d) => `Atrasado: entregue ${d.title} agora`,
      body: (d, link, h) =>
        `Você prometeu entregar até ${h.when(d.delivery_due_at)}. O comprador já pode cancelar com reembolso total, e o pedido será reembolsado automaticamente em ${d.auto_refund_hours} horas. ` +
        `Atrasos reduzem sua taxa de pontualidade, que aparece no seu perfil.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    referral_reward: {
      subject: (d, h) => `Você ganhou ${h.money(d.amount_cents, d.currency)} de crédito na Bullizard`,
      body: (d, link, h) => `Um amigo que você convidou concluiu o primeiro pedido. ${h.money(d.amount_cents, d.currency)} de crédito estão na sua conta e são usados no checkout.\n\n${link('/account')}`,
    },
    protection_ending: {
      subject: (d) => `Faltam 24 horas para conferir ${d.title}`,
      body: (d, link, h) => `O vendedor recebe automaticamente em ${h.when(d.protection_ends_at)}. Se algo estiver errado com seu pedido, abra uma disputa antes disso.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    seller_new_order: {
      subject: (d) => (d.delivery_mode === 'manual' ? `Novo pedido para entregar: ${d.title}` : `Vendido: ${d.title}`),
      body: (d, link, h) =>
        (d.delivery_mode === 'manual'
          ? `Um comprador pagou ${h.money(d.amount_cents, d.currency)} por “${d.title}” x${d.quantity}. Entregue pela página do pedido; o pagamento fica em custódia até lá.`
          : `“${d.title}” x${d.quantity} foi vendido por ${h.money(d.amount_cents, d.currency)} e entregue automaticamente do seu estoque.`) +
        `\n\n${link(`/orders/${d.order_id}`)}`,
    },
    seller_paid: {
      subject: (d, h) => `${h.money(d.seller_net_cents, d.currency)} adicionados ao seu saldo`,
      body: (d, link, h) => `O pedido “${d.title}” foi concluído. ${h.money(d.seller_net_cents, d.currency)} estão no seu saldo, prontos para saque.\n\n${link('/sell')}`,
    },
    withdrawal_paid: {
      subject: (d, h) => `Saque de ${h.money(d.amount_cents, d.currency)} enviado`,
      body: (d, _link, h) => `Enviamos ${h.money(d.amount_cents, d.currency)} para sua conta de recebimento (referência ${d.provider_ref}).`,
    },
    dispute_opened: {
      subject: (d) => `Disputa aberta em ${d.title}`,
      body: (d, link) => `Uma disputa foi aberta: “${d.reason}”. O pagamento fica congelado até um árbitro analisar o chat do pedido. Adicione suas provas ao chat agora.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    dispute_resolved: {
      subject: (d) => `Disputa resolvida: ${d.title}`,
      body: (d, link) => `O árbitro decidiu a favor do ${d.outcome === 'buyer' ? 'comprador' : 'vendedor'}. Observação: “${d.note}”\n\n${link(`/orders/${d.order_id}`)}`,
    },
    chargeback_received: {
      subject: (d) => `Chargeback no pedido ${String(d.order_id).slice(0, 8)}`,
      body: (d, _link, h) =>
        `O banco do comprador estornou ${h.money(d.amount_cents)} (${d.network} ${d.reason_code}). Enviamos as provas automaticamente.\n\n` +
        (d.seller_protected ? 'A proteção contra chargeback cobre este pedido: seu saldo não é afetado.' : 'Este anúncio não tinha prova verificada de dono original, então o valor foi descontado do seu saldo. Se o banco decidir a nosso favor, ele é devolvido.'),
    },
    kyc_result: {
      subject: (d) => (d.approved ? 'Sua identidade foi verificada' : 'Não conseguimos verificar sua identidade'),
      body: (d, link) => (d.approved ? `Agora você pode anunciar, usar a API de vendedor e sacar.\n\n${link('/sell')}` : `Tente novamente com uma foto nítida de um documento válido.\n\n${link('/account')}`),
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
      subject: (d, h) => `Falha no saque de ${h.money(d.amount_cents, d.currency)}`,
      body: (d, link, h) => `Seu saque de ${h.money(d.amount_cents, d.currency)} não pôde ser enviado (${d.reason}). O dinheiro voltou para o seu saldo. Confira sua conta de recebimento: ${link('/sell')}`,
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
      body: (d, link) => `Houve ${d.failures} tentativas de login malsucedidas na sua conta, então o acesso está pausado por ${d.minutes} minutos. Se não foi você, sua conta está segura, mas recomendamos ativar a verificação em duas etapas. Você também pode redefinir a senha agora: ${link('/forgot-password')}`,
    },
  },
};
export default pt;

import { simpleDuration, type LocalePack } from './types.js';

const U = { minute: 'minuto', minutes: 'minutos', hour: 'hora', hours: 'horas' };

const es: LocalePack = {
  layout: { greeting: "Hola, {name}:", greetingNoName: "Hola:", signoff: "El equipo de Bullizard", why: "Recibes este correo porque tienes una cuenta en Bullizard.", safety: "Nunca te pediremos tu contraseña ni tus códigos por correo.", manage: "Ajustes de correo", legal: "Bullizard · Solo mayores de 18 · Sin relación con ningún editor de juegos", button: "Abrir Bullizard" },
  verifySubject: (code) => `Tu código de Bullizard: ${code}`,
  verifyCode: (code, minutes) => `Tu código es ${code}. Sirve durante ${simpleDuration(minutes, U)}. Si no lo pediste, ignora este correo.`,
  duration: (minutes) => simpleDuration(minutes, U),
  withdrawalReasons: { unsupported_coin: "Los pagos se envían solo en USDT. Añade una dirección USDT (TRC-20 o BEP-20) y vuelve a intentarlo.", not_approved: "No se aprobó. Contacta con soporte si necesitas los detalles.", provider_failed: "La red de pago lo rechazó. Revisa tu dirección y vuelve a intentarlo." },
  templates: {
    protection_ending: {
      subject: (d) => `Quedan 24 horas para comprobar ${d.title}`,
      body: (d, link, h) => `El vendedor cobrará automáticamente el ${h.when(d.protection_ends_at)}. Si algo va mal con tu pedido, abre una disputa antes.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    dispute_statement: {
      subject: () => 'Nueva declaración en tu disputa',
      body: (d, link) => `El ${d.role === 'buyer' ? 'comprador' : 'vendedor'} añadió una declaración a la disputa. Léela y responde en el chat del pedido o con tu propia declaración antes de que decida el árbitro.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    warranty_claim: {
      subject: (d) => `Reclamación de garantía en ${d.title}`,
      body: (d, link) => {
        const r = ({ recovered: "el propietario original recuperó la cuenta", banned: "la cuenta fue baneada", locked: "la cuenta está bloqueada" } as Record<string, string>)[d.reason as string] ?? "la cuenta dejó de funcionar";
        return `El comprador dice que ${r}. Tienes ${d.hours} horas para arreglarlo, reembolsar o impugnarlo; después decide un árbitro. El pago de este pedido queda retenido hasta que se resuelva.\n\n${link(`/orders/${d.order_id}`)}`;
      },
    },
    warranty_update: {
      subject: (d) => `Novedades de la reclamación de garantía: ${d.title}`,
      body: (d, link) => {
        const b = d.role === 'buyer';
        const m: Record<string, string> = { seller_fixed: b ? "El vendedor dice que la cuenta vuelve a funcionar. Confírmalo o envía la reclamación a un árbitro si no es así." : "Has indicado que está arreglado. El comprador tiene 72 horas para confirmarlo.", escalated: "La reclamación ha pasado a un árbitro, que leerá el chat del pedido y decidirá.", resolved: "Reclamación resuelta: la cuenta vuelve a funcionar.", refunded: b ? "Se te ha reembolsado por la garantía." : "Se reembolsó al comprador por la garantía, con el pago retenido de este pedido.", rejected: "Un árbitro rechazó la reclamación.", withdrawn: "El comprador retiró la reclamación." };
        return `${m[d.status as string] ?? "La reclamación se ha actualizado."}\n\n${link(`/orders/${d.order_id}`)}`;
      },
    },
    order_progress: {
      subject: (d) => `${d.percent}% hecho: ${d.title}`,
      body: (d, link) => `El vendedor publicó el progreso de «${d.title}»: ${d.percent}%${d.note ? `. «${d.note}»` : '.'}\n\n${link(`/orders/${d.order_id}`)}`,
    },
    chargeback_received: {
      subject: (d) => `Contracargo en el pedido ${String(d.order_id).slice(0, 8)}`,
      body: (d, _link, h) =>
        `El banco del comprador revirtió ${h.money(d.amount_cents)} (${d.network} ${d.reason_code}). Hemos enviado las pruebas automáticamente.\n\n` +
        (d.seller_protected ? 'El Escudo de contracargos cubre este pedido: tu saldo no se ve afectado.' : 'Esta oferta no tenía prueba verificada de propietario original, así que el importe se descontó de tu saldo. Si el banco nos da la razón, se te devuelve.'),
    },
    new_signin: {
      subject: () => 'Nuevo inicio de sesión en tu cuenta de Bullizard',
      body: (d, link, h) => `Se inició sesión en tu cuenta desde un dispositivo nuevo (${d.userAgent ?? 'navegador desconocido'}, IP ${d.ip ?? 'desconocida'}) el ${h.when(d.at)}.\n\n¿No has sido tú? Cambia la contraseña y cierra la sesión en otros dispositivos: ${link('/account')}`,
    },
    password_reset: {
      subject: () => 'Restablece tu contraseña de Bullizard',
      body: (d) =>
        `Alguien pidió restablecer la contraseña de esta cuenta${d.ip ? ` (desde la IP ${d.ip})` : ''}. Usa este enlace en los próximos ${d.minutes} minutos:\n\n${d.url}\n\n` +
        `Si no lo pediste, ignora este correo; tu contraseña no cambia.`,
    },
    new_review: {
      subject: (d) => `Nueva reseña de ${d.rating} estrellas`,
      body: (d, link) => `Un comprador valoró el pedido «${d.title}» con ${d.rating}/5${d.comment ? `: «${d.comment}»` : '.'}\n\nPuedes publicar una respuesta pública: ${link('/sell')}`,
    },
    password_changed: {
      subject: () => 'Tu contraseña ha cambiado',
      body: (_d, link) => `Tu contraseña se ha cambiado y se cerró la sesión en tus otros dispositivos. ¿No has sido tú? Restablécela de inmediato: ${link('/account')}`,
    },
    mfa_changed: {
      subject: (d) => (d.enabled ? 'Verificación en dos pasos activada' : 'Verificación en dos pasos desactivada'),
      body: (d, link) => `La verificación en dos pasos se ha ${d.enabled ? 'activado' : 'desactivado'} en tu cuenta y se cerró la sesión en otros dispositivos. ¿No has sido tú? ${link('/account')}`,
    },
    session_reuse_detected: {
      subject: () => 'Hemos cerrado la sesión de un dispositivo que podría estar comprometido',
      body: (d, link) => `Un token de acceso de uno de tus dispositivos (${d.userAgent ?? 'navegador desconocido'}) se usó dos veces, lo que suele indicar que fue copiado. Hemos cerrado esa sesión. Cambia la contraseña si no lo esperabas: ${link('/account')}`,
    },
    clawback: {
      subject: (d) => `Reembolso tras la liberación: ${d.title}`,
      body: (d, link, h) =>
        `Tras revisar el pedido «${d.title}», hemos reembolsado al comprador (${d.reason}). Tu parte, ${h.money(d.amount_cents, d.currency)}, se descontó de tu saldo; si queda por debajo de cero, se recupera de tus próximas ventas. También se devolvió la comisión (nota de crédito ${d.credit_note}).\n\n${link(`/orders/${d.order_id}`)}`,
    },
    withdrawal_failed: {
      subject: (d, h) => `Retiro de ${h.money(d.amount_cents, d.currency)} no enviado`,
      body: (d, link, h) => `No pudimos enviar tu retiro de ${h.money(d.amount_cents, d.currency)}. ${h.reason(d.reason)} El dinero ha vuelto a tu saldo.

Abrir cartera: ${link('/sell/money')}`,
    },
    invoice_issued: {
      subject: (d) => `Tu factura de comisiones ${d.number}`,
      body: (d, link, h) => `La factura ${d.number} de ${d.period} está lista: comisión ${h.money(d.gross_cents, d.currency)}, de la que ${h.money(d.tax_cents, d.currency)} son impuestos. Ya se descontó de tus ventas.\n\n${link('/sell/invoices')}`,
    },
    debt_reminder: {
      subject: (d, h) => (d.first ? `Tu saldo es de ${h.money(-d.amount_cents, d.currency)}` : `Recordatorio: debes ${h.money(d.amount_cents, d.currency)}`),
      body: (d, link, h) =>
        `Tu saldo en Bullizard está ${h.money(d.amount_cents, d.currency)} por debajo de cero tras un reembolso o contracargo. Las nuevas ventas lo cubren automáticamente, o puedes pagarlo ya con tarjeta. ` +
        `Los retiros están en pausa hasta saldarlo, y si sigue pendiente el ${h.when(d.pause_at)} tu tienda se pausará.\n\n${link('/sell/money')}`,
    },
    debt_shop_paused: {
      subject: () => 'Tu tienda está en pausa hasta que saldes tu saldo',
      body: (d, link, h) =>
        `Tu saldo sigue ${h.money(d.amount_cents, d.currency)} por debajo de cero, así que tus ofertas están ocultas y no se pueden comprar. Los pedidos ya pagados aún deben entregarse. ` +
        `Paga el saldo para reabrir tu tienda al instante.\n\n${link('/sell/money')}`,
    },
    debt_cleared: {
      subject: () => 'Tu saldo está al día',
      body: (d, link) => `Tu saldo en ${d.currency} vuelve a estar por encima de cero${d.reason === 'written_off' ? ' (hemos condonado el resto)' : ''}. ${d.resumed ? 'Tu tienda vuelve a estar abierta. ' : ''}Los retiros funcionan con normalidad.\n\n${link('/sell/money')}`,
    },
    watch_price_drop: {
      subject: (d, h) => `Bajada de precio: ${d.title} ahora a ${h.money(d.price_cents, d.currency)}`,
      body: (d, link, h) =>
        `${d.title} cuesta ahora ${h.money(d.price_cents, d.currency)}${d.target_cents ? `, en tu objetivo de ${h.money(d.target_cents, d.currency)} o por debajo` : ', menos que cuando empezaste a seguirlo'}.\n\n${link(`/offers/${d.offer_id}`)}`,
    },
    watch_back_in_stock: {
      subject: (d) => `De nuevo en stock: ${d.title}`,
      body: (d, link, h) => `${d.title} vuelve a estar disponible a ${h.money(d.price_cents, d.currency)}.\n\n${link(`/offers/${d.offer_id}`)}`,
    },
    saved_search_digest: {
      subject: (d) => `${d.count} ${d.count === 1 ? 'oferta nueva' : 'ofertas nuevas'} para «${d.name}»`,
      body: (d, link, h) =>
        `Novedades desde la última vez, la más barata primero:\n\n${(d.top as any[]).map((o) => `- ${o.title}: ${h.money(o.price_cents, o.currency)}`).join('\n')}\n\nVer las ${d.count}: ${link(d.path)}\n\nCambia o detén este resumen en tu lista de seguimiento: ${link('/watchlist')}`,
    },
    watch_game_low: {
      subject: (d, h) => `${d.game}${d.attributes && Object.keys(d.attributes).length ? ` (${Object.values(d.attributes).join(', ')})` : ''}: desde ${h.money(d.price_cents, d.currency)}`,
      body: (d, link, h) =>
        `Una oferta de ${d.game} que sigues está ${d.target_cents ? `en tu objetivo de ${h.money(d.target_cents, d.currency)} o por debajo` : 'en un nuevo mínimo'}: «${d.title}» por ${h.money(d.price_cents, d.currency)}.\n\n${link(`/offers/${d.offer_id}`)}`,
    },
    request_posted: {
      subject: (d) => `Nueva solicitud en ${d.game}: ${d.title}`,
      body: (d, link, h) => `Un comprador busca «${d.title}»${d.budget_cents ? ` con un presupuesto de ${h.money(d.budget_cents, d.currency)}` : ''}. Vendes en ${d.game}, así que quizá tengas lo que necesita. Envía un precio y un plazo de entrega.\n\n${link(`/requests/${d.request_id}`)}`,
    },
    request_proposal: {
      subject: (d) => `${d.revised ? 'Propuesta actualizada' : 'Nueva propuesta'} para «${d.title}»`,
      body: (d, link, h) => `${d.seller_name} ofrece ${h.money(d.price_cents, d.currency)} con entrega en ${d.delivery_hours} horas. Acéptala para pagar; tu pago queda en custodia como en cualquier pedido.\n\n${link(`/requests/${d.request_id}`)}`,
    },
    request_accepted: {
      subject: (d) => `Propuesta aceptada: ${d.title}`,
      body: (d, link, h) => `El comprador aceptó tu propuesta de ${h.money(d.price_cents, d.currency)}. Creamos una oferta privada para él; recibirás el aviso habitual de nuevo pedido en cuanto pague.\n\n${link(`/requests/${d.request_id}`)}`,
    },
    listing_review: {
      subject: () => 'Tu oferta está en revisión',
      body: (d, link) => `${d.title ? `«${d.title}»` : 'Tu oferta'} menciona algo que nuestras normas nos piden revisar (productos prohibidos o datos de contacto), así que está oculta hasta que un moderador la vea, normalmente en pocas horas. Te avisaremos en cualquier caso.\n\n${link('/sell')}`,
    },
    listing_approved: {
      subject: (d) => `Oferta aprobada: ${d.title}`,
      body: (d, link) => `Un moderador aprobó «${d.title}» y vuelve a estar publicada.\n\n${link(`/offers/${d.offer_id}`)}`,
    },
    listing_rejected: {
      subject: (d) => `Oferta retirada: ${d.title}`,
      body: (d, link) => `Un moderador retiró «${d.title}»: ${d.note}\n\nPuedes publicar una nueva oferta que cumpla las normas. Escribe a soporte si crees que es un error.\n\n${link('/support/new?category=selling')}`,
    },
    support_received: {
      subject: (d) => `Hemos recibido tu solicitud n.º ${d.number}`,
      body: (d, link) => `Gracias por escribirnos sobre «${d.subject}». Nuestro equipo suele responder en pocas horas; te avisaremos por correo cuando lo haga.\n\n${link(`/support/${d.ticket_id}`)}`,
    },
    support_reply: {
      subject: (d) => (d.resolved ? `Solicitud n.º ${d.number} resuelta` : `Nueva respuesta en la solicitud n.º ${d.number}`),
      body: (d, link) =>
        `El soporte de Bullizard respondió a «${d.subject}»${d.resolved ? ' y la marcó como resuelta. Responde si aún necesitas ayuda y se reabrirá' : ''}:\n\n${d.preview}\n\n${link(`/support/${d.ticket_id}`)}`,
    },
    support_auto_resolved: {
      subject: (d) => `Solicitud n.º ${d.number} cerrada`,
      body: (d, link) => `No hemos sabido nada sobre «${d.subject}» en ${d.days} días, así que la marcamos como resuelta. Responde cuando quieras para reabrirla.\n\n${link(`/support/${d.ticket_id}`)}`,
    },
    account_locked: {
      subject: () => 'Inicio de sesión en pausa tras intentos fallidos',
      body: (d, link, h) => `Alguien intentó entrar en tu cuenta y falló la contraseña ${d.failures} veces, así que el acceso queda en pausa ${h.duration(Number(d.minutes))}. Si fuiste tú, espera o restablece tu contraseña. Si no, tu cuenta sigue a salvo. Activa la verificación en dos pasos para que siga así.

Restablecer contraseña: ${link('/forgot-password')}`,
    },
  },
};
export default es;

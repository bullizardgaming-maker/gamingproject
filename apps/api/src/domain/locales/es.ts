import type { LocalePack } from './types.js';

const es: LocalePack = {
  signoff: '— El equipo de Bullizard',
  manage: 'Gestionar correos',
  verifyCode: (code, minutes) => `Tu código de verificación es ${code}. Caduca en ${minutes} minutos.`,
  templates: {
    order_paid: {
      subject: (d) => `Pago recibido por ${d.title}`,
      body: (d, link, h) => `Hemos recibido ${h.money(d.amount_cents, d.currency)} por «${d.title}». Queda en garantía y el vendedor no cobra hasta que tengas lo comprado.\n\nSigue el pedido: ${link(`/orders/${d.order_id}`)}`,
    },
    order_delivered: {
      subject: (d) => `Entregado: ${d.title}`,
      body: (d, link, h) =>
        `Tu pedido «${d.title}» se ha entregado. Ábrelo para verlo.\n\n` +
        (d.protection === 'insurance_14d'
          ? `Esta cuenta tiene seguro de 14 días hasta el ${h.when(d.protection_ends_at)}. Completa ahora la lista de seguridad: cambia la contraseña, el correo de recuperación y el 2FA.`
          : `Tienes hasta el ${h.when(d.protection_ends_at)} para comprobarlo. Si algo falla, abre una disputa antes.`) +
        `\n\n${link(`/orders/${d.order_id}`)}`,
    },
    order_refunded: {
      subject: (d) => `Reembolso de ${d.title}`,
      body: (d, link, h) => `Hemos devuelto ${h.money(d.amount_cents, d.currency)} a tu método de pago original. Los reembolsos con tarjeta suelen aparecer en 5–10 días hábiles.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    delivery_late: {
      subject: (d) => `Tu pedido va con retraso: ${d.title}`,
      body: (d, link, h) =>
        `El vendedor prometió entregarlo antes del ${h.when(d.delivery_due_at)} y aún no lo ha hecho. Puedes esperar o cancelar ahora con reembolso completo. ` +
        `Si no se entrega en ${d.auto_refund_hours} horas, te lo reembolsamos automáticamente.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    delivery_overdue: {
      subject: (d) => `Atrasado: entrega ${d.title} ya`,
      body: (d, link, h) =>
        `Prometiste entregar antes del ${h.when(d.delivery_due_at)}. El comprador ya puede cancelar con reembolso completo y el pedido se reembolsará solo en ${d.auto_refund_hours} horas. ` +
        `Las entregas tardías bajan tu tasa de puntualidad, que los compradores ven en tu perfil.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    referral_reward: {
      subject: (d, h) => `Has ganado ${h.money(d.amount_cents, d.currency)} de saldo en Bullizard`,
      body: (d, link, h) => `Un amigo al que invitaste completó su primer pedido. Tienes ${h.money(d.amount_cents, d.currency)} de saldo que se aplica al pagar.\n\n${link('/account')}`,
    },
    protection_ending: {
      subject: (d) => `Quedan 24 horas para comprobar ${d.title}`,
      body: (d, link, h) => `El vendedor cobrará automáticamente el ${h.when(d.protection_ends_at)}. Si algo va mal con tu pedido, abre una disputa antes.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    seller_new_order: {
      subject: (d) => (d.delivery_mode === 'manual' ? `Nuevo pedido por entregar: ${d.title}` : `Vendido: ${d.title}`),
      body: (d, link, h) =>
        (d.delivery_mode === 'manual'
          ? `Un comprador pagó ${h.money(d.amount_cents, d.currency)} por «${d.title}» x${d.quantity}. Entrégalo desde la página del pedido; el pago queda en garantía hasta entonces.`
          : `«${d.title}» x${d.quantity} se vendió por ${h.money(d.amount_cents, d.currency)} y se entregó automáticamente de tu stock.`) +
        `\n\n${link(`/orders/${d.order_id}`)}`,
    },
    seller_paid: {
      subject: (d, h) => `${h.money(d.seller_net_cents, d.currency)} añadidos a tu saldo`,
      body: (d, link, h) => `El pedido «${d.title}» se ha completado. ${h.money(d.seller_net_cents, d.currency)} ya están en tu saldo, listos para retirar.\n\n${link('/sell')}`,
    },
    withdrawal_paid: {
      subject: (d, h) => `Retiro de ${h.money(d.amount_cents, d.currency)} enviado`,
      body: (d, _link, h) => `Hemos enviado ${h.money(d.amount_cents, d.currency)} a tu cuenta de cobro (referencia ${d.provider_ref}).`,
    },
    dispute_opened: {
      subject: (d) => `Disputa abierta en ${d.title}`,
      body: (d, link) => `Se ha abierto una disputa: «${d.reason}». El pago queda congelado hasta que un árbitro revise el chat del pedido. Añade ya tus pruebas al chat.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    dispute_statement: {
      subject: () => 'Nueva declaración en tu disputa',
      body: (d, link) => `El ${d.role === 'buyer' ? 'comprador' : 'vendedor'} añadió una declaración a la disputa. Léela y responde en el chat del pedido o con tu propia declaración antes de que decida el árbitro.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    dispute_resolved: {
      subject: (d) => `Disputa resuelta: ${d.title}`,
      body: (d, link) => `El árbitro falló a favor del ${d.outcome === 'buyer' ? 'comprador' : 'vendedor'}. Nota: «${d.note}»\n\n${link(`/orders/${d.order_id}`)}`,
    },
    chargeback_received: {
      subject: (d) => `Contracargo en el pedido ${String(d.order_id).slice(0, 8)}`,
      body: (d, _link, h) =>
        `El banco del comprador revirtió ${h.money(d.amount_cents)} (${d.network} ${d.reason_code}). Hemos enviado las pruebas automáticamente.\n\n` +
        (d.seller_protected ? 'El Escudo de contracargos cubre este pedido: tu saldo no se ve afectado.' : 'Esta oferta no tenía prueba verificada de propietario original, así que el importe se descontó de tu saldo. Si el banco nos da la razón, se te devuelve.'),
    },
    kyc_result: {
      subject: (d) => (d.approved ? 'Tu identidad está verificada' : 'No pudimos verificar tu identidad'),
      body: (d, link) => (d.approved ? `Ya puedes publicar ofertas, usar la API de vendedores y retirar.\n\n${link('/sell')}` : `Inténtalo de nuevo con una foto nítida de un documento válido.\n\n${link('/account')}`),
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
      subject: (d, h) => `Falló el retiro de ${h.money(d.amount_cents, d.currency)}`,
      body: (d, link, h) => `No se pudo enviar tu retiro de ${h.money(d.amount_cents, d.currency)} (${d.reason}). El dinero ha vuelto a tu saldo. Revisa tu cuenta de cobro: ${link('/sell')}`,
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
      subject: () => 'Inicio de sesión en pausa tras varios intentos fallidos',
      body: (d, link) => `Hubo ${d.failures} intentos fallidos de iniciar sesión en tu cuenta, así que el acceso queda en pausa ${d.minutes} minutos. Si no fuiste tú, tu cuenta está a salvo, pero te recomendamos activar la verificación en dos pasos. También puedes restablecer la contraseña ahora: ${link('/forgot-password')}`,
    },
  },
};
export default es;

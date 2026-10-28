import { simpleDuration, type LocalePack } from './types.js';

const U = { minute: 'minute', minutes: 'minutes', hour: 'heure', hours: 'heures' };

const fr: LocalePack = {
  layout: { greeting: "Bonjour {name},", greetingNoName: "Bonjour,", signoff: "L’équipe Bullizard", why: "Vous recevez cet e-mail parce que vous avez un compte Bullizard.", safety: "Nous ne vous demanderons jamais votre mot de passe ni vos codes par e-mail.", manage: "Paramètres e-mail", legal: "Bullizard · Réservé aux 18 ans et plus · Sans lien avec un éditeur de jeux", button: "Ouvrir Bullizard" },
  verifySubject: (code) => `Votre code Bullizard : ${code}`,
  verifyCode: (code, minutes) => `Votre code est ${code}. Il est valable ${simpleDuration(minutes, U)}. Si vous ne l’avez pas demandé, ignorez cet e-mail.`,
  duration: (minutes) => simpleDuration(minutes, U),
  withdrawalReasons: { unsupported_coin: "Les paiements partent uniquement en USDT. Ajoutez une adresse USDT (TRC-20 ou BEP-20) et réessayez.", not_approved: "Il n’a pas été approuvé. Contactez le support si vous voulez les détails.", provider_failed: "Le réseau de paiement l’a refusé. Vérifiez votre adresse et réessayez." },
  templates: {
    protection_ending: {
      subject: (d) => `Plus que 24 heures pour vérifier ${d.title}`,
      body: (d, link, h) => `Le vendeur sera payé automatiquement le ${h.when(d.protection_ends_at)}. Si quelque chose ne va pas, ouvrez un litige avant.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    dispute_statement: {
      subject: () => 'Nouvelle déclaration dans votre litige',
      body: (d, link) => `${d.role === 'buyer' ? 'L’acheteur' : 'Le vendeur'} a ajouté une déclaration au litige. Lisez-la et répondez dans la discussion de la commande ou par votre propre déclaration avant la décision de l’arbitre.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    warranty_claim: {
      subject: (d) => `Réclamation de garantie sur ${d.title}`,
      body: (d, link) => {
        const r = ({ recovered: "le propriétaire d’origine a récupéré le compte", banned: "le compte a été banni", locked: "le compte est verrouillé" } as Record<string, string>)[d.reason as string] ?? "le compte ne fonctionne plus";
        return `L’acheteur indique que ${r}. Vous avez ${d.hours} heures pour corriger, rembourser ou contester ; ensuite un arbitre tranche. Le paiement de cette commande reste bloqué jusqu’au règlement.\n\n${link(`/orders/${d.order_id}`)}`;
      },
    },
    warranty_update: {
      subject: (d) => `Mise à jour de la réclamation de garantie : ${d.title}`,
      body: (d, link) => {
        const b = d.role === 'buyer';
        const m: Record<string, string> = { seller_fixed: b ? "Le vendeur indique que le compte fonctionne de nouveau. Confirmez-le, ou transmettez la réclamation à un arbitre si ce n’est pas le cas." : "Vous avez signalé une correction. L’acheteur a 72 heures pour confirmer.", escalated: "La réclamation est transmise à un arbitre, qui lira la discussion de la commande et tranchera.", resolved: "Réclamation réglée : le compte fonctionne de nouveau.", refunded: b ? "Vous avez été remboursé au titre de la garantie." : "L’acheteur a été remboursé au titre de la garantie, sur le paiement bloqué de cette commande.", rejected: "Un arbitre a rejeté la réclamation.", withdrawn: "L’acheteur a retiré la réclamation." };
        return `${m[d.status as string] ?? "La réclamation a été mise à jour."}\n\n${link(`/orders/${d.order_id}`)}`;
      },
    },
    order_progress: {
      subject: (d) => `${d.percent} % fait : ${d.title}`,
      body: (d, link) => `Le vendeur a publié l’avancement de « ${d.title} » : ${d.percent} %${d.note ? `. « ${d.note} »` : '.'}\n\n${link(`/orders/${d.order_id}`)}`,
    },
    chargeback_received: {
      subject: (d) => `Rétrofacturation sur la commande ${String(d.order_id).slice(0, 8)}`,
      body: (d, _link, h) =>
        `La banque de l’acheteur a annulé ${h.money(d.amount_cents)} (${d.network} ${d.reason_code}). Nous avons transmis les preuves automatiquement.\n\n` +
        (d.seller_protected ? 'Le bouclier anti-rétrofacturation couvre cette commande : votre solde n’est pas touché.' : 'Cette offre n’avait pas de preuve vérifiée de propriétaire d’origine : le montant a été prélevé sur votre solde. Si la banque nous donne raison, il vous sera rendu.'),
    },
    new_signin: {
      subject: () => 'Nouvelle connexion à votre compte Bullizard',
      body: (d, link, h) => `Votre compte s’est connecté depuis un nouvel appareil (${d.userAgent ?? 'navigateur inconnu'}, IP ${d.ip ?? 'inconnue'}) le ${h.when(d.at)}.\n\nCe n’était pas vous ? Changez votre mot de passe et déconnectez les autres appareils : ${link('/account')}`,
    },
    password_reset: {
      subject: () => 'Réinitialisez votre mot de passe Bullizard',
      body: (d) =>
        `Une réinitialisation du mot de passe de ce compte a été demandée${d.ip ? ` (depuis l’IP ${d.ip})` : ''}. Utilisez ce lien dans les ${d.minutes} minutes :\n\n${d.url}\n\n` +
        `Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail ; votre mot de passe reste inchangé.`,
    },
    new_review: {
      subject: (d) => `Nouvel avis ${d.rating} étoiles`,
      body: (d, link) => `Un acheteur a noté la commande « ${d.title} » ${d.rating}/5${d.comment ? ` : « ${d.comment} »` : '.'}\n\nVous pouvez publier une réponse publique : ${link('/sell')}`,
    },
    password_changed: {
      subject: () => 'Votre mot de passe a été modifié',
      body: (_d, link) => `Votre mot de passe a été modifié et vos autres appareils ont été déconnectés. Ce n’était pas vous ? Réinitialisez-le immédiatement : ${link('/account')}`,
    },
    mfa_changed: {
      subject: (d) => (d.enabled ? 'Double authentification activée' : 'Double authentification désactivée'),
      body: (d, link) => `La double authentification a été ${d.enabled ? 'activée' : 'désactivée'} sur votre compte et les autres appareils ont été déconnectés. Ce n’était pas vous ? ${link('/account')}`,
    },
    session_reuse_detected: {
      subject: () => 'Nous avons déconnecté un appareil peut-être compromis',
      body: (d, link) => `Un jeton de connexion de l’un de vos appareils (${d.userAgent ?? 'navigateur inconnu'}) a été utilisé deux fois, ce qui signifie généralement qu’il a été copié. Nous avons déconnecté cet appareil. Changez votre mot de passe si cela vous surprend : ${link('/account')}`,
    },
    clawback: {
      subject: (d) => `Remboursement après versement : ${d.title}`,
      body: (d, link, h) =>
        `Après examen de la commande « ${d.title} », nous avons remboursé l’acheteur (${d.reason}). Votre part, ${h.money(d.amount_cents, d.currency)}, a été prélevée sur votre solde ; s’il passe sous zéro, elle sera récupérée sur vos prochaines ventes. La commission a aussi été rendue (avoir ${d.credit_note}).\n\n${link(`/orders/${d.order_id}`)}`,
    },
    withdrawal_failed: {
      subject: (d, h) => `Retrait de ${h.money(d.amount_cents, d.currency)} non envoyé`,
      body: (d, link, h) => `Nous n’avons pas pu envoyer votre retrait de ${h.money(d.amount_cents, d.currency)}. ${h.reason(d.reason)} L’argent est revenu sur votre solde.

Ouvrir le portefeuille : ${link('/sell/money')}`,
    },
    invoice_issued: {
      subject: (d) => `Votre facture de commission ${d.number}`,
      body: (d, link, h) => `La facture ${d.number} pour ${d.period} est prête : commission ${h.money(d.gross_cents, d.currency)}, dont ${h.money(d.tax_cents, d.currency)} de taxe. Elle a déjà été déduite de vos ventes.\n\n${link('/sell/invoices')}`,
    },
    debt_reminder: {
      subject: (d, h) => (d.first ? `Votre solde est de ${h.money(-d.amount_cents, d.currency)}` : `Rappel : vous devez ${h.money(d.amount_cents, d.currency)}`),
      body: (d, link, h) =>
        `Votre solde Bullizard est négatif de ${h.money(d.amount_cents, d.currency)} après un remboursement ou une rétrofacturation. Les nouvelles ventes le comblent automatiquement, ou vous pouvez le régler par carte. ` +
        `Les retraits sont suspendus jusqu’au règlement, et s’il n’est pas réglé le ${h.when(d.pause_at)}, votre boutique sera mise en pause.\n\n${link('/sell/money')}`,
    },
    debt_shop_paused: {
      subject: () => 'Votre boutique est en pause jusqu’au règlement de votre solde',
      body: (d, link, h) =>
        `Votre solde reste négatif de ${h.money(d.amount_cents, d.currency)} : vos offres sont masquées et ne peuvent pas être achetées. Les commandes déjà payées doivent quand même être livrées. ` +
        `Réglez le solde pour rouvrir votre boutique immédiatement.\n\n${link('/sell/money')}`,
    },
    debt_cleared: {
      subject: () => 'Votre solde est régularisé',
      body: (d, link) => `Votre solde en ${d.currency} est repassé au-dessus de zéro${d.reason === 'written_off' ? ' (nous avons annulé le reste)' : ''}. ${d.resumed ? 'Votre boutique est rouverte. ' : ''}Les retraits fonctionnent normalement.\n\n${link('/sell/money')}`,
    },
    watch_price_drop: {
      subject: (d, h) => `Baisse de prix : ${d.title} à ${h.money(d.price_cents, d.currency)}`,
      body: (d, link, h) =>
        `${d.title} coûte maintenant ${h.money(d.price_cents, d.currency)}${d.target_cents ? `, à votre prix cible de ${h.money(d.target_cents, d.currency)} ou moins` : ', moins que lorsque vous avez commencé à le suivre'}.\n\n${link(`/offers/${d.offer_id}`)}`,
    },
    watch_back_in_stock: {
      subject: (d) => `De retour en stock : ${d.title}`,
      body: (d, link, h) => `${d.title} est de nouveau disponible à ${h.money(d.price_cents, d.currency)}.\n\n${link(`/offers/${d.offer_id}`)}`,
    },
    watch_game_low: {
      subject: (d, h) => `${d.game}${d.attributes && Object.keys(d.attributes).length ? ` (${Object.values(d.attributes).join(', ')})` : ''} : dès ${h.money(d.price_cents, d.currency)}`,
      body: (d, link, h) =>
        `Une offre ${d.game} que vous suivez est ${d.target_cents ? `à votre prix cible de ${h.money(d.target_cents, d.currency)} ou moins` : 'à un nouveau prix bas'} : « ${d.title} » à ${h.money(d.price_cents, d.currency)}.\n\n${link(`/offers/${d.offer_id}`)}`,
    },
    request_posted: {
      subject: (d) => `Nouvelle demande dans ${d.game} : ${d.title}`,
      body: (d, link, h) => `Un acheteur cherche « ${d.title} »${d.budget_cents ? ` avec un budget de ${h.money(d.budget_cents, d.currency)}` : ''}. Vous vendez sur ${d.game}, vous avez peut-être ce qu’il lui faut. Envoyez un prix et un délai de livraison.\n\n${link(`/requests/${d.request_id}`)}`,
    },
    request_proposal: {
      subject: (d) => `${d.revised ? 'Proposition mise à jour' : 'Nouvelle proposition'} pour « ${d.title} »`,
      body: (d, link, h) => `${d.seller_name} propose ${h.money(d.price_cents, d.currency)} avec une livraison sous ${d.delivery_hours} heures. Acceptez-la pour payer ; votre paiement est conservé sous séquestre comme pour toute commande.\n\n${link(`/requests/${d.request_id}`)}`,
    },
    request_accepted: {
      subject: (d) => `Proposition acceptée : ${d.title}`,
      body: (d, link, h) => `L’acheteur a accepté votre proposition de ${h.money(d.price_cents, d.currency)}. Nous avons créé une offre privée pour lui ; vous recevrez l’avis habituel de nouvelle commande dès son paiement.\n\n${link(`/requests/${d.request_id}`)}`,
    },
    listing_review: {
      subject: () => 'Votre offre est en cours de vérification',
      body: (d, link) => `${d.title ? `« ${d.title} »` : 'Votre offre'} mentionne un élément que nos règles nous demandent de vérifier (produits interdits ou coordonnées), elle est donc masquée jusqu’à l’examen d’un modérateur, en général sous quelques heures. Vous serez prévenu dans tous les cas.\n\n${link('/sell')}`,
    },
    listing_approved: {
      subject: (d) => `Offre approuvée : ${d.title}`,
      body: (d, link) => `Un modérateur a approuvé « ${d.title} », elle est de nouveau en ligne.\n\n${link(`/offers/${d.offer_id}`)}`,
    },
    listing_rejected: {
      subject: (d) => `Offre retirée : ${d.title}`,
      body: (d, link) => `Un modérateur a retiré « ${d.title} » : ${d.note}\n\nVous pouvez publier une nouvelle offre conforme aux règles. Contactez le support si vous pensez qu’il s’agit d’une erreur.\n\n${link('/support/new?category=selling')}`,
    },
    support_received: {
      subject: (d) => `Nous avons bien reçu votre demande n° ${d.number}`,
      body: (d, link) => `Merci de nous avoir écrit au sujet de « ${d.subject} ». Notre équipe répond généralement en quelques heures ; vous recevrez un e-mail à sa réponse.\n\n${link(`/support/${d.ticket_id}`)}`,
    },
    support_reply: {
      subject: (d) => (d.resolved ? `Demande n° ${d.number} résolue` : `Nouvelle réponse à la demande n° ${d.number}`),
      body: (d, link) =>
        `Le support Bullizard a répondu à « ${d.subject} »${d.resolved ? ' et l’a marquée comme résolue. Répondez si vous avez encore besoin d’aide, elle sera rouverte' : ''} :\n\n${d.preview}\n\n${link(`/support/${d.ticket_id}`)}`,
    },
    support_auto_resolved: {
      subject: (d) => `Demande n° ${d.number} clôturée`,
      body: (d, link) => `Sans nouvelles de votre part concernant « ${d.subject} » depuis ${d.days} jours, nous l’avons marquée comme résolue. Répondez à tout moment pour la rouvrir.\n\n${link(`/support/${d.ticket_id}`)}`,
    },
    account_locked: {
      subject: () => 'Connexion suspendue après des tentatives échouées',
      body: (d, link, h) => `Quelqu’un a essayé de se connecter à votre compte et s’est trompé de mot de passe ${d.failures} fois : la connexion est suspendue pendant ${h.duration(Number(d.minutes))}. Si c’était vous, patientez ou réinitialisez votre mot de passe. Sinon, votre compte reste en sécurité. Activez la double authentification pour qu’il le reste.

Réinitialiser le mot de passe : ${link('/forgot-password')}`,
    },
  },
};
export default fr;

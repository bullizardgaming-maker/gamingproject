import type { LocalePack } from './types.js';

const de: LocalePack = {
  signoff: '— Dein Bullizard-Team',
  manage: 'E-Mail-Einstellungen',
  verifyCode: (code, minutes) => `Dein Bestätigungscode lautet ${code}. Er läuft in ${minutes} Minuten ab.`,
  templates: {
    order_paid: {
      subject: (d) => `Zahlung für ${d.title} erhalten`,
      body: (d, link, h) => `Wir haben ${h.money(d.amount_cents, d.currency)} für „${d.title}“ erhalten. Das Geld liegt treuhänderisch bereit, der Verkäufer wird erst bezahlt, wenn du die Ware hast.\n\nBestellung verfolgen: ${link(`/orders/${d.order_id}`)}`,
    },
    order_delivered: {
      subject: (d) => `Geliefert: ${d.title}`,
      body: (d, link, h) =>
        `Deine Bestellung „${d.title}“ wurde geliefert. Öffne die Bestellseite, um sie zu sehen.\n\n` +
        (d.protection === 'insurance_14d'
          ? `Dieser Account ist bis ${h.when(d.protection_ends_at)} mit 14 Tagen Versicherung geschützt. Arbeite jetzt die Sicherheits-Checkliste ab: Passwort, Wiederherstellungs-E-Mail und 2FA ändern.`
          : `Du hast bis ${h.when(d.protection_ends_at)} Zeit, alles zu prüfen. Stimmt etwas nicht, eröffne vorher einen Streitfall.`) +
        `\n\n${link(`/orders/${d.order_id}`)}`,
    },
    order_refunded: {
      subject: (d) => `Erstattung für ${d.title}`,
      body: (d, link, h) => `${h.money(d.amount_cents, d.currency)} wurden auf dein ursprüngliches Zahlungsmittel erstattet. Kartenerstattungen erscheinen meist innerhalb von 5–10 Werktagen.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    delivery_late: {
      subject: (d) => `Deine Bestellung ist verspätet: ${d.title}`,
      body: (d, link, h) =>
        `Der Verkäufer hat die Lieferung bis ${h.when(d.delivery_due_at)} zugesagt und noch nicht geliefert. Du kannst warten oder jetzt mit voller Erstattung stornieren. ` +
        `Kommt die Lieferung nicht innerhalb von ${d.auto_refund_hours} Stunden, erstatten wir automatisch.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    delivery_overdue: {
      subject: (d) => `Überfällig: Liefere ${d.title} jetzt`,
      body: (d, link, h) =>
        `Du hast die Lieferung bis ${h.when(d.delivery_due_at)} zugesagt. Der Käufer kann jetzt mit voller Erstattung stornieren, und in ${d.auto_refund_hours} Stunden wird automatisch erstattet. ` +
        `Verspätungen senken deine Pünktlichkeitsquote, die Käufer in deinem Profil sehen.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    referral_reward: {
      subject: (d, h) => `Du hast ${h.money(d.amount_cents, d.currency)} Bullizard-Guthaben verdient`,
      body: (d, link, h) => `Ein Freund, den du eingeladen hast, hat seine erste Bestellung abgeschlossen. ${h.money(d.amount_cents, d.currency)} Guthaben sind auf deinem Konto und werden beim Bezahlen angerechnet.\n\n${link('/account')}`,
    },
    protection_ending: {
      subject: (d) => `Noch 24 Stunden, um ${d.title} zu prüfen`,
      body: (d, link, h) => `Der Verkäufer wird am ${h.when(d.protection_ends_at)} automatisch bezahlt. Stimmt etwas mit deiner Bestellung nicht, eröffne vorher einen Streitfall.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    seller_new_order: {
      subject: (d) => (d.delivery_mode === 'manual' ? `Neue Bestellung zu liefern: ${d.title}` : `Verkauft: ${d.title}`),
      body: (d, link, h) =>
        (d.delivery_mode === 'manual'
          ? `Ein Käufer hat ${h.money(d.amount_cents, d.currency)} für „${d.title}“ x${d.quantity} bezahlt. Liefere über die Bestellseite; bis dahin bleibt die Zahlung treuhänderisch verwahrt.`
          : `„${d.title}“ x${d.quantity} wurde für ${h.money(d.amount_cents, d.currency)} verkauft und automatisch aus deinem Bestand geliefert.`) +
        `\n\n${link(`/orders/${d.order_id}`)}`,
    },
    seller_paid: {
      subject: (d, h) => `${h.money(d.seller_net_cents, d.currency)} deinem Guthaben gutgeschrieben`,
      body: (d, link, h) => `Die Bestellung „${d.title}“ ist abgeschlossen. ${h.money(d.seller_net_cents, d.currency)} sind jetzt in deinem Guthaben und können ausgezahlt werden.\n\n${link('/sell')}`,
    },
    withdrawal_paid: {
      subject: (d, h) => `Auszahlung von ${h.money(d.amount_cents, d.currency)} gesendet`,
      body: (d, _link, h) => `Wir haben ${h.money(d.amount_cents, d.currency)} an dein Auszahlungskonto gesendet (Referenz ${d.provider_ref}).`,
    },
    dispute_opened: {
      subject: (d) => `Streitfall zu ${d.title} eröffnet`,
      body: (d, link) => `Ein Streitfall wurde eröffnet: „${d.reason}“. Die Zahlung ist eingefroren, bis ein Schlichter den Bestell-Chat prüft. Füge jetzt Nachweise im Chat hinzu.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    dispute_statement: {
      subject: () => 'Neue Stellungnahme in deinem Streitfall',
      body: (d, link) => `Der ${d.role === 'buyer' ? 'Käufer' : 'Verkäufer'} hat eine Stellungnahme zum Streitfall hinzugefügt. Lies sie und antworte im Bestell-Chat oder mit deiner eigenen Stellungnahme, bevor der Schlichter entscheidet.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    warranty_claim: {
      subject: (d) => `Garantieanspruch zu ${d.title}`,
      body: (d, link) => {
        const r = ({ recovered: "der ursprüngliche Besitzer hat den Account zurückgeholt", banned: "der Account wurde gebannt", locked: "der Account ist gesperrt" } as Record<string, string>)[d.reason as string] ?? "der Account funktioniert nicht mehr";
        return `Der Käufer meldet: ${r}. Du hast ${d.hours} Stunden, um es zu beheben, zu erstatten oder zu widersprechen; danach entscheidet ein Schlichter. Die Auszahlung dieser Bestellung bleibt bis dahin zurückgehalten.\n\n${link(`/orders/${d.order_id}`)}`;
      },
    },
    warranty_update: {
      subject: (d) => `Neuigkeiten zum Garantieanspruch: ${d.title}`,
      body: (d, link) => {
        const b = d.role === 'buyer';
        const m: Record<string, string> = { seller_fixed: b ? "Der Verkäufer sagt, der Account funktioniert wieder. Bestätige das oder gib den Anspruch an einen Schlichter, falls nicht." : "Du hast eine Lösung gemeldet. Der Käufer hat 72 Stunden zum Bestätigen.", escalated: "Der Anspruch liegt jetzt bei einem Schlichter, der den Bestellchat liest und entscheidet.", resolved: "Anspruch erledigt: Der Account funktioniert wieder.", refunded: b ? "Du hast über die Garantie eine Erstattung erhalten." : "Der Käufer wurde über die Garantie aus der zurückgehaltenen Auszahlung dieser Bestellung erstattet.", rejected: "Ein Schlichter hat den Anspruch abgelehnt.", withdrawn: "Der Käufer hat den Anspruch zurückgezogen." };
        return `${m[d.status as string] ?? "Der Anspruch wurde aktualisiert."}\n\n${link(`/orders/${d.order_id}`)}`;
      },
    },
    order_progress: {
      subject: (d) => `${d.percent} % erledigt: ${d.title}`,
      body: (d, link) => `Der Verkäufer hat den Fortschritt für „${d.title}“ gemeldet: ${d.percent} %${d.note ? `. „${d.note}“` : '.'}\n\n${link(`/orders/${d.order_id}`)}`,
    },
    dispute_resolved: {
      subject: (d) => `Streitfall entschieden: ${d.title}`,
      body: (d, link) => `Der Schlichter hat zugunsten des ${d.outcome === 'buyer' ? 'Käufers' : 'Verkäufers'} entschieden. Hinweis: „${d.note}“\n\n${link(`/orders/${d.order_id}`)}`,
    },
    chargeback_received: {
      subject: (d) => `Rückbuchung zu Bestellung ${String(d.order_id).slice(0, 8)}`,
      body: (d, _link, h) =>
        `Die Bank des Käufers hat ${h.money(d.amount_cents)} zurückgebucht (${d.network} ${d.reason_code}). Wir haben die Nachweise automatisch eingereicht.\n\n` +
        (d.seller_protected ? 'Der Chargeback-Schutz deckt diese Bestellung ab: Dein Guthaben bleibt unberührt.' : 'Dieses Angebot hatte keinen verifizierten Erstbesitzer-Nachweis, daher wurde der Betrag von deinem Guthaben abgezogen. Entscheidet die Bank zu unseren Gunsten, bekommst du ihn zurück.'),
    },
    kyc_result: {
      subject: (d) => (d.approved ? 'Deine Identität ist bestätigt' : 'Wir konnten deine Identität nicht bestätigen'),
      body: (d, link) => (d.approved ? `Du kannst jetzt Angebote einstellen, die Verkäufer-API nutzen und auszahlen.\n\n${link('/sell')}` : `Bitte versuche es erneut mit einem scharfen Foto eines gültigen Ausweises.\n\n${link('/account')}`),
    },
    new_signin: {
      subject: () => 'Neue Anmeldung bei deinem Bullizard-Konto',
      body: (d, link, h) => `Dein Konto wurde am ${h.when(d.at)} von einem neuen Gerät angemeldet (${d.userAgent ?? 'unbekannter Browser'}, IP ${d.ip ?? 'unbekannt'}).\n\nWarst du das nicht? Ändere dein Passwort und melde andere Geräte ab: ${link('/account')}`,
    },
    password_reset: {
      subject: () => 'Setze dein Bullizard-Passwort zurück',
      body: (d) =>
        `Jemand hat das Zurücksetzen des Passworts für dieses Konto angefordert${d.ip ? ` (von IP ${d.ip})` : ''}. Nutze diesen Link innerhalb von ${d.minutes} Minuten:\n\n${d.url}\n\n` +
        `Wenn du das nicht warst, ignoriere diese E-Mail; dein Passwort bleibt unverändert.`,
    },
    new_review: {
      subject: (d) => `Neue ${d.rating}-Sterne-Bewertung`,
      body: (d, link) => `Ein Käufer hat die Bestellung „${d.title}“ mit ${d.rating}/5 bewertet${d.comment ? `: „${d.comment}“` : '.'}\n\nDu kannst eine öffentliche Antwort schreiben: ${link('/sell')}`,
    },
    password_changed: {
      subject: () => 'Dein Passwort wurde geändert',
      body: (_d, link) => `Dein Passwort wurde geändert und deine anderen Geräte wurden abgemeldet. Warst du das nicht? Setze dein Passwort sofort zurück: ${link('/account')}`,
    },
    mfa_changed: {
      subject: (d) => (d.enabled ? 'Zwei-Faktor-Anmeldung aktiviert' : 'Zwei-Faktor-Anmeldung deaktiviert'),
      body: (d, link) => `Die Zwei-Faktor-Anmeldung wurde für dein Konto ${d.enabled ? 'aktiviert' : 'deaktiviert'}, andere Geräte wurden abgemeldet. Warst du das nicht? ${link('/account')}`,
    },
    session_reuse_detected: {
      subject: () => 'Wir haben ein möglicherweise kompromittiertes Gerät abgemeldet',
      body: (d, link) => `Ein Anmelde-Token eines deiner Geräte (${d.userAgent ?? 'unbekannter Browser'}) wurde zweimal verwendet – meist ein Zeichen, dass es kopiert wurde. Wir haben das Gerät abgemeldet. Ändere dein Passwort, falls du das nicht erwartet hast: ${link('/account')}`,
    },
    clawback: {
      subject: (d) => `Erstattung nach Freigabe: ${d.title}`,
      body: (d, link, h) =>
        `Nach Prüfung der Bestellung „${d.title}“ haben wir dem Käufer erstattet (${d.reason}). Dein Anteil von ${h.money(d.amount_cents, d.currency)} wurde von deinem Guthaben abgezogen; fällt es unter null, wird der Rest mit deinen nächsten Verkäufen verrechnet. Die Provision wurde ebenfalls erstattet (Gutschrift ${d.credit_note}).\n\n${link(`/orders/${d.order_id}`)}`,
    },
    withdrawal_failed: {
      subject: (d, h) => `Auszahlung von ${h.money(d.amount_cents, d.currency)} fehlgeschlagen`,
      body: (d, link, h) => `Deine Auszahlung von ${h.money(d.amount_cents, d.currency)} konnte nicht gesendet werden (${d.reason}). Das Geld ist wieder in deinem Guthaben. Prüfe dein Auszahlungskonto: ${link('/sell')}`,
    },
    invoice_issued: {
      subject: (d) => `Deine Provisionsrechnung ${d.number}`,
      body: (d, link, h) => `Rechnung ${d.number} für ${d.period} ist bereit: Provision ${h.money(d.gross_cents, d.currency)}, davon Steuer ${h.money(d.tax_cents, d.currency)}. Sie wurde bereits von deinen Verkäufen abgezogen.\n\n${link('/sell/invoices')}`,
    },
    debt_reminder: {
      subject: (d, h) => (d.first ? `Dein Guthaben beträgt ${h.money(-d.amount_cents, d.currency)}` : `Erinnerung: Du schuldest ${h.money(d.amount_cents, d.currency)}`),
      body: (d, link, h) =>
        `Dein Bullizard-Guthaben liegt nach einer Erstattung oder Rückbuchung ${h.money(d.amount_cents, d.currency)} unter null. Neue Verkäufe gleichen es automatisch aus, oder du zahlst jetzt per Karte. ` +
        `Auszahlungen sind bis zum Ausgleich pausiert, und ist es am ${h.when(d.pause_at)} noch offen, wird dein Shop pausiert.\n\n${link('/sell/money')}`,
    },
    debt_shop_paused: {
      subject: () => 'Dein Shop ist pausiert, bis dein Guthaben ausgeglichen ist',
      body: (d, link, h) =>
        `Dein Guthaben liegt weiterhin ${h.money(d.amount_cents, d.currency)} unter null, daher sind deine Angebote ausgeblendet und nicht kaufbar. Bereits bezahlte Bestellungen müssen trotzdem geliefert werden. ` +
        `Gleiche das Guthaben aus, um deinen Shop sofort wieder zu öffnen.\n\n${link('/sell/money')}`,
    },
    debt_cleared: {
      subject: () => 'Dein Guthaben ist ausgeglichen',
      body: (d, link) => `Dein ${d.currency}-Guthaben liegt wieder über null${d.reason === 'written_off' ? ' (den Rest haben wir abgeschrieben)' : ''}. ${d.resumed ? 'Dein Shop ist wieder geöffnet. ' : ''}Auszahlungen funktionieren wie gewohnt.\n\n${link('/sell/money')}`,
    },
    watch_price_drop: {
      subject: (d, h) => `Preissenkung: ${d.title} jetzt ${h.money(d.price_cents, d.currency)}`,
      body: (d, link, h) =>
        `${d.title} kostet jetzt ${h.money(d.price_cents, d.currency)}${d.target_cents ? ` und liegt damit bei oder unter deinem Ziel von ${h.money(d.target_cents, d.currency)}` : ', weniger als zu Beginn deiner Beobachtung'}.\n\n${link(`/offers/${d.offer_id}`)}`,
    },
    watch_back_in_stock: {
      subject: (d) => `Wieder verfügbar: ${d.title}`,
      body: (d, link, h) => `${d.title} ist wieder für ${h.money(d.price_cents, d.currency)} erhältlich.\n\n${link(`/offers/${d.offer_id}`)}`,
    },
    saved_search_digest: {
      subject: (d) => `${d.count} ${d.count === 1 ? 'neues Angebot' : 'neue Angebote'} für „${d.name}“`,
      body: (d, link, h) =>
        `Neu seit dem letzten Mal, günstigstes zuerst:\n\n${(d.top as any[]).map((o) => `- ${o.title}: ${h.money(o.price_cents, o.currency)}`).join('\n')}\n\nAlle ${d.count} ansehen: ${link(d.path)}\n\nÄndere oder beende diese Zusammenfassung auf deiner Merkliste: ${link('/watchlist')}`,
    },
    watch_game_low: {
      subject: (d, h) => `${d.game}${d.attributes && Object.keys(d.attributes).length ? ` (${Object.values(d.attributes).join(', ')})` : ''}: ab ${h.money(d.price_cents, d.currency)}`,
      body: (d, link, h) =>
        `Ein beobachtetes ${d.game}-Angebot liegt ${d.target_cents ? `bei oder unter deinem Ziel von ${h.money(d.target_cents, d.currency)}` : 'auf einem neuen Tiefstand'}: „${d.title}“ für ${h.money(d.price_cents, d.currency)}.\n\n${link(`/offers/${d.offer_id}`)}`,
    },
    request_posted: {
      subject: (d) => `Neue Anfrage in ${d.game}: ${d.title}`,
      body: (d, link, h) => `Ein Käufer sucht „${d.title}“${d.budget_cents ? ` mit einem Budget von ${h.money(d.budget_cents, d.currency)}` : ''}. Du verkaufst in ${d.game} und hast vielleicht, was er braucht. Sende einen Preis und eine Lieferzeit.\n\n${link(`/requests/${d.request_id}`)}`,
    },
    request_proposal: {
      subject: (d) => `${d.revised ? 'Aktualisiertes Angebot' : 'Neues Angebot'} für „${d.title}“`,
      body: (d, link, h) => `${d.seller_name} bietet ${h.money(d.price_cents, d.currency)} mit Lieferung innerhalb von ${d.delivery_hours} Stunden. Nimm es an, um zu bezahlen; deine Zahlung liegt wie bei jeder Bestellung auf dem Treuhandkonto.\n\n${link(`/requests/${d.request_id}`)}`,
    },
    request_accepted: {
      subject: (d) => `Angebot angenommen: ${d.title}`,
      body: (d, link, h) => `Der Käufer hat dein Angebot über ${h.money(d.price_cents, d.currency)} angenommen. Wir haben ein privates Angebot für ihn erstellt; sobald er bezahlt, bekommst du die übliche Benachrichtigung über die neue Bestellung.\n\n${link(`/requests/${d.request_id}`)}`,
    },
    listing_review: {
      subject: () => 'Dein Angebot wird geprüft',
      body: (d, link) => `${d.title ? `„${d.title}“` : 'Dein Angebot'} enthält etwas, das wir laut unseren Regeln prüfen müssen (verbotene Waren oder Kontaktdaten). Es ist daher ausgeblendet, bis ein Moderator es ansieht, meist innerhalb weniger Stunden. Du hörst in jedem Fall von uns.\n\n${link('/sell')}`,
    },
    listing_approved: {
      subject: (d) => `Angebot freigegeben: ${d.title}`,
      body: (d, link) => `Ein Moderator hat „${d.title}“ freigegeben, es ist wieder online.\n\n${link(`/offers/${d.offer_id}`)}`,
    },
    listing_rejected: {
      subject: (d) => `Angebot entfernt: ${d.title}`,
      body: (d, link) => `Ein Moderator hat „${d.title}“ entfernt: ${d.note}\n\nDu kannst ein neues Angebot einstellen, das den Regeln entspricht. Schreib dem Support, wenn du das für einen Fehler hältst.\n\n${link('/support/new?category=selling')}`,
    },
    support_received: {
      subject: (d) => `Wir haben deine Anfrage #${d.number} erhalten`,
      body: (d, link) => `Danke für deine Nachricht zu „${d.subject}“. Unser Support antwortet meist innerhalb weniger Stunden; du bekommst eine E-Mail, sobald er antwortet.\n\n${link(`/support/${d.ticket_id}`)}`,
    },
    support_reply: {
      subject: (d) => (d.resolved ? `Anfrage #${d.number} gelöst` : `Neue Antwort auf Anfrage #${d.number}`),
      body: (d, link) =>
        `Der Bullizard-Support hat auf „${d.subject}“ geantwortet${d.resolved ? ' und sie als gelöst markiert. Antworte, falls du noch Hilfe brauchst – dann wird sie wieder geöffnet' : ''}:\n\n${d.preview}\n\n${link(`/support/${d.ticket_id}`)}`,
    },
    support_auto_resolved: {
      subject: (d) => `Anfrage #${d.number} geschlossen`,
      body: (d, link) => `Wir haben seit ${d.days} Tagen nichts zu „${d.subject}“ gehört und die Anfrage daher als gelöst markiert. Antworte jederzeit, um sie wieder zu öffnen.\n\n${link(`/support/${d.ticket_id}`)}`,
    },
    account_locked: {
      subject: () => 'Anmeldung nach Fehlversuchen pausiert',
      body: (d, link) => `Es gab ${d.failures} fehlgeschlagene Anmeldeversuche für dein Konto, daher ist die Anmeldung für ${d.minutes} Minuten pausiert. Warst du das nicht, ist dein Konto sicher – wir empfehlen trotzdem die Zwei-Faktor-Anmeldung. Du kannst dein Passwort auch jetzt zurücksetzen: ${link('/forgot-password')}`,
    },
  },
};
export default de;

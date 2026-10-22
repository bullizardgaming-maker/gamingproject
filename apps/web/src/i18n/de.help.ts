import type { HelpPack } from './index';

const help: HelpPack = {
  topics: {
    buying: { title: 'Kaufen', blurb: 'Angebote finden, bestellen und Gekauftes erhalten.' },
    protection: { title: 'Streitfälle & Schutz', blurb: 'Treuhand, Prüffrist, Versicherung und Erstattungen.' },
    payments: { title: 'Zahlungen', blurb: 'Karten, Krypto, Währungen und Guthaben.' },
    selling: { title: 'Verkaufen', blurb: 'Angebote, Lieferung, Gebühren und Auszahlungen.' },
    account: { title: 'Konto & Sicherheit', blurb: 'Verifizierung, Zwei-Faktor-Anmeldung und deine Daten.' },
  },
  articles: {
    'how-escrow-works': {
      title: 'So schützt die Treuhand deine Bestellung',
      summary: 'Deine Zahlung wartet bei uns, bis du hast, wofür du bezahlt hast.',
      body: [
        'Wenn du bezahlst, geht das Geld in die Treuhand, nicht an den Verkäufer. Der Verkäufer sieht nur, dass bezahlt ist, und kann liefern.',
        'Nach der Lieferung hast du eine Schutzfrist, um alles zu prüfen: 72 Stunden für Keys, Währung, Items, Aufladungen und Boosting, 14 Tage Versicherung für Spiel-Accounts.',
        'Der Verkäufer wird bezahlt, wenn du die Bestellung bestätigst oder die Frist ohne Streitfall endet – je nachdem, was zuerst eintritt. Stimmt etwas nicht, eröffne vor Ablauf einen Streitfall auf der Bestellseite; das Geld bleibt bis zur Klärung eingefroren.',
      ],
    },
    'order-not-delivered': {
      title: 'Meine Bestellung wurde nicht geliefert',
      summary: 'Was du tun kannst, wenn ein Verkäufer zu spät ist, und wann du automatisch dein Geld zurückbekommst.',
      body: [
        'Angebote mit Sofortlieferung werden geliefert, sobald die Zahlung durch ist; sieh auf der Bestellseite nach. Bei manuellen Angeboten verspricht der Verkäufer eine Lieferzeit, die im Angebot steht.',
        'Schreib dem Verkäufer zuerst im Bestell-Chat; die meisten Verzögerungen klären sich dort. Ist die zugesagte Zeit vorbei, erinnern wir den Verkäufer, und liefert er dann immer noch nicht, wird die Bestellung storniert und automatisch erstattet.',
        'Du kannst auch jederzeit einen Streitfall auf der Bestellseite eröffnen, solange die Zahlung in der Treuhand ist.',
      ],
    },
    'open-a-dispute': {
      title: 'Einen Streitfall eröffnen',
      summary: 'Entspricht etwas nicht der Beschreibung, entscheidet ein Schlichter anhand des Bestell-Chats und der Nachweise.',
      body: [
        'Eröffne einen Streitfall auf der Bestellseite, solange die Bestellung in ihrer Schutzfrist ist. Erkläre, was nicht stimmt, und füge Screenshots in den Bestell-Chat ein.',
        'Die Zahlung bleibt eingefroren, während ein Bullizard-Schlichter den Chat, die Lieferprotokolle und die Nachweise beider Seiten prüft.',
        '- Entscheidet der Schlichter für dich, wird der volle Betrag auf dein ursprüngliches Zahlungsmittel erstattet.\n- Entscheidet er für den Verkäufer, wird die Zahlung an ihn freigegeben.',
      ],
    },
    'account-insurance': {
      title: 'Account-Versicherung und Inhabernachweis',
      summary: 'Warum Account-Angebote 14 Tage versichert sind und was „Inhaber verifiziert“ bedeutet.',
      body: [
        'Ein Vorbesitzer kann einen Account zurückholen, deshalb sind Account-Bestellungen 14 Tage nach Lieferung versichert: Wird der Account in dieser Zeit zurückgeholt, bekommst du dein Geld zurück.',
        'Angebote mit „Inhaber verifiziert“ stammen vom Erstbesitzer, der uns die Registrierungs-E-Mail und frühe Kaufbelege gezeigt hat. Angebote ohne Nachweis gelten als riskant; Treuhand und Versicherung gelten trotzdem.',
        'Ändere nach der Übergabe sofort E-Mail, Passwort und Zwei-Faktor-Einstellungen.',
      ],
    },
    'game-fields-and-filters': {
      title: 'Nach Server, Region, Plattform und Rang filtern',
      summary: 'Nutze die Auswahlfelder auf jeder Spieleseite, um nur passende Angebote zu sehen.',
      body: [
        'Viele Spiele teilen ihren Markt auf: League of Legends nach Server, Valorant nach Region, World of Warcraft nach Realm und Fraktion, CS2-Skins nach Zustand. Öffne ein Spiel, wähle eine Kategorie und nutze die Auswahlfelder über der Angebotstabelle.',
        'Jede Option zeigt, wie viele aktive Angebote sie mit deinen übrigen Filtern hat. Verkäufer müssen diese Felder ausfüllen, deshalb sind die Filter verlässlich.',
      ],
    },
    'price-alerts': {
      title: 'Merkliste und Preisalarme',
      summary: 'Beobachte ein Angebot oder einen ganzen Markt und erfahre von jedem neuen Tiefstpreis.',
      body: [
        'Nutze „Preisalarm“ bei einem Angebot oder „Bei neuen Tiefstpreisen benachrichtigen“ auf einer Spieleseite (deine Server- oder Regionsfilter bleiben erhalten). Du kannst einen Zielpreis setzen oder das Feld leer lassen, um bei jeder Senkung informiert zu werden.',
        'Wir prüfen alle paar Minuten und melden jeden neuen Tiefstpreis einmal, außerdem wenn ein ausverkauftes Angebot wieder verfügbar ist. Alles verwaltest du in deiner Merkliste.',
      ],
    },
    'payment-methods': {
      title: 'Zahlungsarten',
      summary: 'Karte über eine sichere gehostete Kasse oder USDC/USDT über einen On-Chain-Treuhandvertrag.',
      body: [
        'Kartenzahlungen laufen über die sichere Seite unseres Zahlungspartners; wir sehen deine Kartennummer nie. Du zahlst den an der Kasse angezeigten Preis in der Währung des Angebots.',
        'Kryptozahlungen nutzen einen On-Chain-Treuhandvertrag mit derselben Schutzfrist. Sende nur den exakten Betrag an die für deine Bestellung angezeigte Vertragsadresse.',
        'Preise in einer anderen Währung sind ungefähre Umrechnungen; die Kasse zeigt immer den exakten Betrag, der abgebucht wird.',
      ],
    },
    'refund-timing': {
      title: 'Wann sehe ich meine Erstattung?',
      summary: 'Erstattungen gehen auf das ursprüngliche Zahlungsmittel zurück; Banken brauchen ein paar Tage.',
      body: [
        'Erstattungen gehen auf die Karte oder Wallet zurück, mit der du bezahlt hast. Kartenerstattungen senden wir sofort; deine Bank zeigt sie meist innerhalb von 5–10 Werktagen an.',
        'Guthaben (aus Aktionen oder Empfehlungen) wird sofort als Guthaben zurückgebucht.',
      ],
    },
    'selling-fees': {
      title: 'Verkaufsgebühren und Stufen',
      summary: 'Die Gebühren sinken mit deinem 30-Tage-Umsatz; Geschenkkarten, Aufladungen und Videospiele haben einen niedrigeren Satz.',
      body: [
        'Jeder Verkauf zahlt eine Provision, die von deiner Verkäuferstufe abhängt – festgelegt durch deinen Umsatz der letzten 30 Tage. Accounts haben einen eigenen Satz; Geschenkkarten, Aufladungen und Videospiele zahlen 4,99 %.',
        'Die genaue Gebühr und deinen Nettoerlös siehst du bei jeder Bestellung, Stufe und Fortschritt im Verkäuferbereich.',
      ],
    },
    'getting-paid': {
      title: 'Auszahlungen erhalten',
      summary: 'Zahle nach Ende der Schutzfrist in USD, EUR oder GBP auf dein Bankkonto aus.',
      body: [
        'Geld aus einem Verkauf wird verfügbar, wenn der Käufer bestätigt oder die Schutzfrist endet. Zahle es im Verkäuferbereich auf das Bankkonto aus, das du bei unserem Zahlungspartner hinterlegt hast.',
        'Neue Verkäufer können eine kurze Auszahlungssperre haben, bis Vertrauen aufgebaut ist; der Verkäuferbereich zeigt, wann gesperrtes Geld frei wird.',
        'Bringt eine Erstattung oder Rückbuchung dein Guthaben unter null, gleichen neue Verkäufe es zuerst aus und Auszahlungen pausieren bis dahin.',
      ],
    },
    'seller-analytics': {
      title: 'Deine Shop-Statistiken verstehen',
      summary: 'Aufrufe, Konversion und Stammkunden – und wie sie gezählt werden.',
      body: [
        'Der Tab „Statistiken“ zeigt Umsatz, Angebotsaufrufe, Konversion (Bestellungen geteilt durch Aufrufe), durchschnittlichen Bestellwert und Stammkunden im Vergleich zum Vorzeitraum.',
        'Ein Aufruf zählt einmal pro Besucher, Angebot und Stunde – nie, wenn du dein eigenes Angebot ansiehst.',
      ],
    },
    'verify-identity': {
      title: 'Deine Identität bestätigen',
      summary: 'Stufe 1 zum Kaufen, Stufe 2 (Ausweis mit Foto) zum Verkaufen.',
      body: [
        'Stufe 1 bedeutet bestätigte E-Mail und Telefonnummer; das reicht zum Kaufen. Stufe 2 ergänzt einen Ausweis mit Foto und einen Lebendigkeitstest über unseren Verifizierungspartner und ist zum Verkaufen nötig.',
        'Die Verifizierung dauert meist ein paar Minuten. Schlägt sie fehl, prüfe, ob das Foto scharf ist und alle Ecken des Dokuments sichtbar sind, und versuche es erneut.',
      ],
    },
    'two-factor': {
      title: 'Zwei-Faktor-Anmeldung und Sicherheit',
      summary: 'Aktiviere eine Authenticator-App und teile niemals Codes im Bestell-Chat.',
      body: [
        'Aktiviere die Zwei-Faktor-Anmeldung unter Konto → Sicherheit mit einer beliebigen Authenticator-App und bewahre deine Wiederherstellungscodes sicher auf.',
        'Das Bullizard-Team fragt nie nach deinem Passwort oder einem Anmeldecode. Bleib mit Deals im Bestell-Chat: In andere Apps verlagerte Deals sind nicht durch die Treuhand geschützt.',
      ],
    },
    'report-a-user': {
      title: 'Betrugsversuche oder Missbrauch melden',
      summary: 'Melde uns Zahlungsaufforderungen außerhalb der Plattform, Phishing-Links oder Belästigung.',
      body: [
        'Fordert dich jemand auf, außerhalb von Bullizard zu zahlen, schickt einen verdächtigen Link oder wird ausfallend, antworte nicht weiter. Schick uns eine Anfrage in der Kategorie „Nutzer melden“ mit dem Namen und der Bestellung oder dem Chat, in dem es passiert ist.',
        'Unser Trust-&-Safety-Team prüft jede Meldung. Das Ergebnis können wir dir nicht immer mitteilen, aber wir handeln.',
      ],
    },
  },
  ticketCategories: {
    order: 'Ein Problem mit einer Bestellung',
    payment: 'Zahlungen und Erstattungen',
    account: 'Mein Konto oder die Verifizierung',
    selling: 'Verkaufen und Auszahlungen',
    report: 'Nutzer melden',
    other: 'Etwas anderes',
  },
};
export default help;

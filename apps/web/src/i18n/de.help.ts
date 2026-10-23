import type { HelpPack } from './index';

const help: HelpPack = {
  topics: {
    buying: { title: 'Kaufen', blurb: 'Angebote finden, bestellen und Gekauftes erhalten.' },
    protection: { title: 'Streitfälle & Schutz', blurb: 'Käuferschutz, Treuhand, Versicherung und Erstattungen.' },
    payments: { title: 'Zahlungen', blurb: 'Krypto, Netzwerkgebühren, deine Wallet und Erstattungen.' },
    selling: { title: 'Verkaufen', blurb: 'Angebote, Lieferung, Gebühren und Auszahlungen.' },
    account: { title: 'Konto & Sicherheit', blurb: 'Verifizierung, Zwei-Faktor-Anmeldung und deine Daten.' },
  },
  articles: {
    'open-a-dispute': {
      title: "Einen Streitfall eröffnen",
      summary: "Wenn etwas nicht wie beschrieben ist, entscheidet ein Schiedsrichter anhand von Chat und Belegen.",
      body: [
        "Eröffne den Streitfall auf der Bestellseite, bevor du die Bestellung bestätigst. Erkläre das Problem und füge Screenshots im Bestell-Chat hinzu.",
        "Die Zahlung bleibt gesperrt, während ein Bullizard-Schiedsrichter Chat, Lieferbelege und Beweise beider Seiten prüft.",
        "- Entscheidet er für dich, wird der volle Betrag deinem Bullizard-Guthaben gutgeschrieben.\n- Entscheidet er für den Verkäufer, wird die Zahlung an ihn freigegeben.",
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
    'price-alerts': {
      title: 'Merkliste und Preisalarme',
      summary: 'Beobachte ein Angebot oder einen ganzen Markt und erfahre von jedem neuen Tiefstpreis.',
      body: [
        'Nutze „Preisalarm“ bei einem Angebot oder „Bei neuen Tiefstpreisen benachrichtigen“ auf einer Spieleseite (deine Server- oder Regionsfilter bleiben erhalten). Du kannst einen Zielpreis setzen oder das Feld leer lassen, um bei jeder Senkung informiert zu werden.',
        'Wir prüfen alle paar Minuten und melden jeden neuen Tiefstpreis einmal, außerdem wenn ein ausverkauftes Angebot wieder verfügbar ist. Alles verwaltest du in deiner Merkliste.',
      ],
    },
    'payment-methods': {
      title: "Zahlungswege",
      summary: "Zahle in Krypto: Wähle einen gängigen Coin; seine Netzwerkgebühr kommt zum Gesamtbetrag dazu.",
      body: [
        "Bezahlt wird in Krypto. Wähle einen Coin aus der Liste; jeder zeigt sein Netzwerk (z. B. TRC-20) und den Gesamtbetrag.",
        "Die Netzwerkgebühr kommt obendrauf: Eine Bestellung über 11,50 $ mit 1,00 $ Gebühr heißt, du sendest 12,50 $. Nur der Bestellbetrag geht an den Verkäufer.",
        "Sende genau den Betrag an die angezeigte Adresse im selben Netzwerk. Die Bestellung ist bezahlt, sobald das Netzwerk bestätigt. Coins mit einem Minimum über deiner Bestellung sind ausgegraut.",
        "Dein Bullizard-Guthaben wird zuerst verwendet.",
      ],
    },
    'delivery-in-game': {
      title: 'So funktioniert die Lieferung im Spiel',
      summary: 'Währung und Items werden an den Charakternamen gehandelt, den du beim Bezahlen bestätigst; der Verkäufer hängt einen Nachweis an und du gibst die Zahlung frei.',
      body: [
        'Bei Spielen mit Lieferung im Spiel (Währung, Items, Aufladungen) nennst du den genauen Charakternamen oder die UID, mit der der Verkäufer handeln soll. Beim Bezahlen bestätigst du sie mit einem Tipp, und sie wird für die nächste Bestellung gemerkt. Prüfe sie sorgfältig: Der Verkäufer liefert an diesen Namen, und du bist dafür verantwortlich, dass er stimmt.',
        'Der Verkäufer handelt mit diesem Charakter und hängt ein Foto oder Video des Handels an, bevor er die Bestellung als geliefert markiert. Den Nachweis siehst du auf der Bestellseite.',
        'Die Zahlung bleibt im Treuhandkonto, bis du den Erhalt bestätigst. Stimmt etwas nicht, eröffne auf der Bestellseite einen Streitfall statt zu bestätigen; das Team vergleicht den Nachweis mit dem Handel und entscheidet.',
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
    'wallet': {
      title: "Deine Wallet",
      summary: "Dein Guthaben und jede Geldbewegung in einer Liste.",
      body: [
        "Öffne die Wallet über das Kontomenü. Oben steht dein Guthaben, darunter jede Bestellung, Erstattung, jeder Verkauf und jede Auszahlung.",
        "- Gelb, Gehalten: Das Geld ist in der Treuhand, bis die Bestellung bestätigt ist.\n- Grün, Abgeschlossen: erledigt.\n- Rot, Storniert: Bestellung oder Auszahlung wurde storniert.\n- Grau, Ausstehend: wartet auf Zahlung oder Freigabe.",
        "Verkäufer sehen ihre Verkäufe in derselben Liste. Auszahlungen und Steuerdokumente findest du im Verkäuferbereich unter Geld.",
      ],
    },
    'sell-by-amount': {
      title: "Währung nach Menge verkaufen",
      summary: "Lege Einheit, Preis pro Einheit, Minimum und Bestand fest; Käufer wählen die Menge.",
      body: [
        "Wähle im Verkaufsformular Währung und gib die Einheit an, z. B. M für Millionen Silber. Der Preis gilt dann pro Einheit.",
        "Lege Bestand und Mindestbestellung fest, beides in Einheiten. Käufer wählen eine Menge zwischen deinem Minimum und deinem Bestand; der Gesamtbetrag passt sich an.",
        "Auf der Spielseite erscheint dein Angebot in der Verkäufertabelle mit Server, Bestand, Minimum, Lieferzeit und Preis pro Einheit.",
      ],
    },
    'seller-badges': {
      title: "Deine Abzeichen und dein Shop",
      summary: "Wähle die 2 Abzeichen, die Käufer neben deinem Namen sehen.",
      body: [
        "Du verdienst Abzeichen beim Verkaufen: deinen Rang, Gründungsverkäufer, ID verifiziert und Top-Verkäufer. Wähle im Verkäuferbereich unter deinem Shop bis zu 2, die neben deinem Namen bei Angeboten erscheinen.",
        "Dein Shop zeigt außerdem deine Sprachen, deine Vorstellung und deine Zahlen: positive Bewertungen, Bewertung, verkaufte Bestellungen und pünktliche Lieferung.",
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

import 'package:finet_mobile/core/money/money.dart';
import 'package:finet_mobile/features/finance/finance_api.dart';
import 'package:finet_mobile/features/finance/models.dart';
import 'package:finet_mobile/features/finance/providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/fake_server.dart';
import '../../support/harness.dart';

const nbsp = ' ';

Future<void> openTransactions(WidgetTester tester) =>
    tester.openTab('Tranzacții');

Future<void> fillAmount(WidgetTester tester, String text) async {
  await tester.enterText(find.widgetWithText(TextFormField, 'Suma'), text);
}

Future<void> tapSave(WidgetTester tester) async {
  await tester.tapVisible(find.widgetWithText(FilledButton, 'Salvează'));
}

void main() {
  group('lista de tranzacții', () {
    testWidgets('prima pagină, apoi încărcare la capătul listei', (
      tester,
    ) async {
      final h = Harness()..signedInStore();
      await h.pump(tester);
      await openTransactions(tester);
      expect(find.text('Cumpărături săptămânale'), findsOneWidget);
      expect(h.container.read(transactionsProvider).items, hasLength(30));
      expect(h.container.read(transactionsProvider).hasMore, isTrue);

      await tester.drag(find.byType(ListView).last, const Offset(0, -6000));
      await tester.pumpAndSettle();
      expect(h.container.read(transactionsProvider).items, hasLength(45));
      expect(h.container.read(transactionsProvider).hasMore, isFalse);
    });

    testWidgets(
      'cheltuiala e negativă, venitul pozitiv; transferul e doar de citit',
      (tester) async {
        final h = Harness()..signedInStore();
        await h.pump(tester);
        await openTransactions(tester);
        expect(
          find.text(
            '-234,80$nbsp'
            'lei',
          ),
          findsOneWidget,
        );
        expect(find.text('7.800,00${nbsp}lei'), findsOneWidget);
        // Transferul nu se editează: atingerea lui nu deschide formularul.
        await tester.tap(find.text('Către numerar'));
        await tester.pumpAndSettle();
        expect(find.text('Editează tranzacția'), findsNothing);
      },
    );

    testWidgets('căutarea trimite q la server după o scurtă pauză', (
      tester,
    ) async {
      final h = Harness()..signedInStore();
      await h.pump(tester);
      await openTransactions(tester);
      await tester.enterText(find.byType(TextField), 'Salariu');
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pumpAndSettle();
      final state = h.container.read(transactionsProvider);
      expect(state.items, hasLength(1));
      expect(state.items.single.title, 'Salariu');
      expect(
        h.server
            .requestsTo('GET /api/v1/transactions')
            .last
            .uri
            .queryParameters['q'],
        'Salariu',
      );
    });

    testWidgets('filtrul pe tip: doar veniturile', (tester) async {
      final h = Harness()..signedInStore();
      await h.pump(tester);
      await openTransactions(tester);
      await tester.tap(find.byTooltip('Filtre'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(ChoiceChip, 'Venit'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Aplică'));
      await tester.pumpAndSettle();
      expect(h.container.read(transactionsProvider).items, hasLength(1));
      expect(
        h.server
            .requestsTo('GET /api/v1/transactions')
            .last
            .uri
            .queryParameters['type'],
        'income',
      );
    });

    testWidgets('fără rezultate: stare goală cu ștergerea filtrelor', (
      tester,
    ) async {
      final h = Harness()..signedInStore();
      await h.pump(tester);
      await openTransactions(tester);
      await tester.enterText(find.byType(TextField), 'inexistent');
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pumpAndSettle();
      expect(
        find.text('Nicio tranzacție pentru filtrele alese'),
        findsOneWidget,
      );
      await tester.tap(find.text('Șterge filtrele'));
      await tester.pumpAndSettle();
      expect(h.container.read(transactionsProvider).items, isNotEmpty);
    });

    testWidgets('eroare la încărcare: mesaj și „Încearcă din nou”', (
      tester,
    ) async {
      final h = Harness()..signedInStore();
      await h.pump(tester);
      h.server.on(
        'GET /api/v1/transactions',
        (_) => finetError(500, 'internal_error', 'Eroare internă'),
      );
      await openTransactions(tester);
      expect(find.text('Eroare internă'), findsOneWidget);
      h.server.routes.remove('GET /api/v1/transactions');
      // Rutele implicite au fost suprascrise; refacem un răspuns valid.
      h.server.on(
        'GET /api/v1/transactions',
        (_) => jsonBody({'data': <Object>[], 'nextCursor': null}),
      );
      await tester.tap(find.text('Încearcă din nou'));
      await tester.pumpAndSettle();
      expect(find.text('Nu ai încă tranzacții'), findsOneWidget);
    });
  });

  group('adăugare', () {
    testWidgets('trimite suma ca amountMinor întreg și apare în listă', (
      tester,
    ) async {
      final h = Harness(clock: () => DateTime.utc(2026, 11, 1, 10))
        ..signedInStore();
      await h.pump(tester);
      await openTransactions(tester);
      await tester.tap(find.text('Adaugă'));
      await tester.pumpAndSettle();
      expect(find.text('Tranzacție nouă'), findsOneWidget);

      await fillAmount(tester, '12,50');
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Descriere'),
        'Cafea',
      );
      await tapSave(tester);

      expect(h.server.created, 1);
      final body = h.server.lastCreateBody!;
      expect(body['amountMinor'], 1250);
      expect(body['type'], 'expense');
      expect(body['occurredOn'], '2026-11-01');
      expect(body['description'], 'Cafea');
      expect(body['merchant'], isNull);
      // Înapoi pe listă, cu noua tranzacție prima.
      expect(find.text('Tranzacție nouă'), findsNothing);
      expect(find.text('Cafea'), findsOneWidget);
    });

    testWidgets('suma invalidă se respinge pe client, cu mesajul din web', (
      tester,
    ) async {
      final h = Harness()..signedInStore();
      await h.pump(tester);
      await openTransactions(tester);
      await tester.tap(find.text('Adaugă'));
      await tester.pumpAndSettle();

      await fillAmount(tester, '1.234');
      await tapSave(tester);
      expect(find.textContaining('ambiguă'), findsOneWidget);
      expect(h.server.created, 0);

      await fillAmount(tester, '0');
      await tapSave(tester);
      expect(
        find.text('Suma trebuie să fie mai mare ca zero.'),
        findsOneWidget,
      );

      await fillAmount(tester, '');
      await tapSave(tester);
      expect(find.text('Introdu o sumă.'), findsOneWidget);
      expect(h.server.created, 0);
    });

    testWidgets('dublu tap pe Salvează creează o singură tranzacție', (
      tester,
    ) async {
      final h = Harness()..signedInStore();
      await h.pump(tester);
      await openTransactions(tester);
      await tester.tap(find.text('Adaugă'));
      await tester.pumpAndSettle();
      await fillAmount(tester, '5');
      final save = find.widgetWithText(FilledButton, 'Salvează');
      await tester.ensureVisible(save);
      await tester.pumpAndSettle();
      await tester.tap(save);
      await tester.tap(save, warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(h.server.created, 1);
    });

    testWidgets(
      'aceeași cheie de idempotență: serverul nu creează a doua oară',
      (tester) async {
        final h = Harness()..signedInStore();
        await h.pump(tester);
        final api = h.container.read(financeApiProvider);
        // Două cereri reale cu aceeași cheie (cum ar face o reîncercare după un timeout).
        Future<void> send(String key) async {
          await api.createTransaction(_draft(), idempotencyKey: key);
        }

        await tester.runAsync(() async {
          await send('cheie-test-0123456789');
          await send('cheie-test-0123456789');
          await send('alta-cheie-0123456789');
        });
        expect(h.server.created, 2);
        final keys = h.server
            .requestsTo('POST /api/v1/transactions')
            .map((r) => r.headers['Idempotency-Key'])
            .toList();
        expect(keys, [
          'cheie-test-0123456789',
          'cheie-test-0123456789',
          'alta-cheie-0123456789',
        ]);
      },
    );

    testWidgets('eroare de server: mesaj în formular, nimic nu se pierde', (
      tester,
    ) async {
      final h = Harness()..signedInStore();
      await h.pump(tester);
      h.server.on(
        'POST /api/v1/transactions',
        (_) => finetError(409, 'conflict', 'Contul este arhivat'),
      );
      await openTransactions(tester);
      await tester.tap(find.text('Adaugă'));
      await tester.pumpAndSettle();
      await fillAmount(tester, '5');
      await tapSave(tester);
      expect(find.text('Contul este arhivat'), findsOneWidget);
      expect(find.text('Tranzacție nouă'), findsOneWidget);
      expect(find.widgetWithText(TextFormField, 'Suma'), findsOneWidget);
    });
  });

  group('editare și ștergere', () {
    testWidgets('editarea trimite PATCH cu valorile noi', (tester) async {
      final h = Harness()..signedInStore();
      await h.pump(tester);
      await openTransactions(tester);
      await tester.tap(find.text('Cumpărături săptămânale'));
      await tester.pumpAndSettle();
      expect(find.text('Editează tranzacția'), findsOneWidget);
      // Suma existentă e precompletată cu virgulă, ca în web.
      expect(find.widgetWithText(TextFormField, '234,80'), findsOneWidget);

      await fillAmount(tester, '250');
      await tapSave(tester);
      expect(h.server.lastPatchBody!['amountMinor'], 25000);
      expect(find.text('Editează tranzacția'), findsNothing);
    });

    testWidgets('ștergerea cere confirmare și elimină rândul', (tester) async {
      final h = Harness()..signedInStore();
      await h.pump(tester);
      await openTransactions(tester);
      await tester.tap(find.byType(PopupMenuButton<String>).first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Șterge'));
      await tester.pumpAndSettle();
      expect(find.text('Ștergi tranzacția?'), findsOneWidget);
      expect(h.server.transactions, hasLength(45));

      await tester.tap(find.widgetWithText(FilledButton, 'Șterge'));
      await tester.pumpAndSettle();
      expect(h.server.transactions, hasLength(44));
      expect(find.text('Cumpărături săptămânale'), findsNothing);
    });

    testWidgets('„Anulează” la ștergere nu șterge nimic', (tester) async {
      final h = Harness()..signedInStore();
      await h.pump(tester);
      await openTransactions(tester);
      await tester.tap(find.byType(PopupMenuButton<String>).first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Șterge'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Anulează'));
      await tester.pumpAndSettle();
      expect(h.server.transactions, hasLength(45));
    });
  });

  group('bugete și obiective', () {
    Future<void> openBudgets(WidgetTester tester) async {
      await tester.openTab('Mai mult');
      await tester.tap(find.text('Bugete și obiective'));
      await tester.pumpAndSettle();
    }

    testWidgets('semaforul vine de la server; starea e și text', (
      tester,
    ) async {
      final h = Harness()..signedInStore();
      await h.pump(tester);
      await openBudgets(tester);
      expect(find.text('În limită'), findsOneWidget);
      expect(find.text('Aproape de limită'), findsOneWidget);
      expect(find.text('Depășit'), findsOneWidget);
      // Bugetul general depășit: rămas negativ → „Depășit cu …”.
      expect(find.text('Depășit cu 623,45${nbsp}lei'), findsOneWidget);
      expect(find.text('General'), findsOneWidget);
      expect(find.text('Transport'), findsOneWidget);
    });

    testWidgets('obiectiv: progres și contribuție cu cheie de idempotență', (
      tester,
    ) async {
      final h = Harness()..signedInStore();
      await h.pump(tester);
      await openBudgets(tester);
      await tester.tap(find.text('Obiective'));
      await tester.pumpAndSettle();
      expect(find.text('Vacanță'), findsOneWidget);
      expect(find.textContaining('30%'), findsOneWidget);

      await tester.tap(find.text('Contribuție'));
      await tester.pumpAndSettle();
      await tester.enterText(find.widgetWithText(TextFormField, 'Suma'), '100');
      await tester.tap(find.widgetWithText(FilledButton, 'Salvează'));
      await tester.tap(
        find.widgetWithText(FilledButton, 'Salvează'),
        warnIfMissed: false,
      );
      await tester.pumpAndSettle();

      expect(h.server.contributions, 1);
      final request = h.server
          .requestsTo(
            'POST /api/v1/goals/f1000000-0000-4000-8000-000000000001/contributions',
          )
          .single;
      expect(request.headers['Idempotency-Key'], isNotNull);
      expect(request.data, {'direction': 'add', 'amountMinor': 10000});
      expect(find.textContaining('32%'), findsOneWidget);
    });
  });

  group('rapoarte', () {
    testWidgets('raportul lunar arată cifrele serverului', (tester) async {
      final h = Harness()..signedInStore();
      await h.pump(tester);
      await tester.openTab('Rapoarte');
      expect(find.text('Raport lunar · RON'), findsOneWidget);
      expect(find.text('Supermarket'), findsOneWidget);
      expect(find.text('980,00${nbsp}lei'), findsOneWidget);
      expect(find.text('2.676,55${nbsp}lei'), findsOneWidget);
    });
  });

  group('sesiune expirată în timpul unei operații', () {
    testWidgets('401 la salvare: login, fără tranzacție creată', (
      tester,
    ) async {
      final h = Harness()..signedInStore();
      await h.pump(tester);
      await openTransactions(tester);
      await tester.tap(find.text('Adaugă'));
      await tester.pumpAndSettle();
      await fillAmount(tester, '5');
      h.server.sessionRevoked = true;
      await tapSave(tester);
      expect(find.text('Autentificare'), findsOneWidget);
      expect(h.server.created, 0);
    });
  });
}

TransactionDraft _draft() => TransactionDraft(
  accountId: FakeServer.accCurrent,
  type: TxType.expense,
  amount: const Money(500, Currency.ron),
  occurredOn: DateTime(2026, 11, 1),
);

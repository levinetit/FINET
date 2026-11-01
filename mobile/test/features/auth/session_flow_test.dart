import 'package:dio/dio.dart';
import 'package:finet_mobile/core/providers.dart';
import 'package:finet_mobile/core/state/privacy.dart';
import 'package:finet_mobile/core/storage/key_value_store.dart';
import 'package:finet_mobile/features/auth/session.dart';
import 'package:finet_mobile/features/settings/app_settings.dart';
import 'package:finet_mobile/features/usage/usage_tracker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/fake_server.dart';
import '../../support/harness.dart';

Future<void> openProfile(WidgetTester tester) async {
  await tester.openTab('Mai mult');
  await tester.tap(find.text('Profil și gospodării'));
  await tester.pumpAndSettle();
}

void main() {
  group('prima pornire', () {
    testWidgets('arată informarea, apoi autentificarea', (tester) async {
      final h = Harness(
        settings: const AppSettings(
          introSeen: false,
          usageStats: true,
          appLock: false,
        ),
      );
      await h.pump(tester);
      expect(find.text('Înainte să începi'), findsOneWidget);
      expect(
        find.textContaining('Nu folosim servicii externe'),
        findsOneWidget,
      );

      await tester.tapVisible(find.widgetWithText(FilledButton, 'Am înțeles'));
      expect(find.text('Autentificare'), findsOneWidget);
      expect(h.memory.values[StoreKeys.introSeen], '1');
      expect(h.memory.values[StoreKeys.usageStats], '1');
    });

    testWidgets('alegerea „fără statistici” se păstrează', (tester) async {
      final h = Harness(
        settings: const AppSettings(
          introSeen: false,
          usageStats: true,
          appLock: false,
        ),
      );
      await h.pump(tester);
      await tester.tapVisible(find.byType(SwitchListTile));
      await tester.tapVisible(find.widgetWithText(FilledButton, 'Am înțeles'));
      expect(h.memory.values[StoreKeys.usageStats], '0');
      expect(h.container.read(usageTrackerProvider).enabled, isFalse);
    });
  });

  group('autentificare', () {
    testWidgets('fără token păstrat cere autentificarea', (tester) async {
      final h = Harness();
      await h.pump(tester);
      expect(find.text('Autentificare'), findsOneWidget);
      expect(h.server.requests, isEmpty);
    });

    testWidgets('parolă greșită: mesaj în română, niciun token păstrat', (
      tester,
    ) async {
      final h = Harness();
      await h.pump(tester);
      await tester.login(password: 'gresita');
      expect(find.text('Email sau parolă incorecte.'), findsOneWidget);
      expect(h.memory.values.containsKey(StoreKeys.sessionToken), isFalse);
      expect(h.container.read(sessionProvider), isA<SignedOut>());
    });

    testWidgets('autentificare reușită: Acasă, token în stocarea securizată', (
      tester,
    ) async {
      final h = Harness();
      await h.pump(tester);
      await tester.login();
      expect(find.text('Sold net'), findsOneWidget);
      expect(h.memory.values[StoreKeys.sessionToken], FakeServer.token);
      expect(h.container.read(sessionProvider), isA<SignedIn>());
    });

    testWidgets(
      'fiecare cerere poartă X-FINET-Client valid; tokenul nu e în URL',
      (tester) async {
        final h = Harness();
        await h.pump(tester);
        await tester.login();
        expect(h.server.requests, isNotEmpty);
        for (final r in h.server.requests) {
          final header = r.headers['X-FINET-Client'] as String;
          expect(header, startsWith('platform=android; '));
          expect(
            header,
            contains('installation=${testClientInfo.installationId}'),
          );
          expect(header, contains('model=Google Pixel 8'));
          expect(r.uri.toString(), isNot(contains(FakeServer.token)));
        }
      },
    );

    testWidgets(
      'clientul HTTP nu are interceptor de log (tokenul nu ajunge în loguri)',
      (tester) async {
        final h = Harness();
        await h.pump(tester);
        final dio = h.container.read(dioProvider);
        expect(dio.interceptors.whereType<LogInterceptor>(), isEmpty);
      },
    );

    testWidgets('token păstrat și valid: intră direct, fără login', (
      tester,
    ) async {
      final h = Harness()..signedInStore();
      await h.pump(tester);
      expect(find.text('Sold net'), findsOneWidget);
      expect(h.server.requestsTo('POST /api/auth/sign-in/email'), isEmpty);
    });

    testWidgets('server căzut la pornire: ecran de reîncercare, apoi intră', (
      tester,
    ) async {
      final h = Harness()..signedInStore();
      h.server.offline = true;
      await h.pump(tester);
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
      expect(find.text('Nu există conexiune la internet.'), findsOneWidget);
      // Tokenul nu se șterge: sesiunea poate fi încă validă.
      expect(h.memory.values[StoreKeys.sessionToken], FakeServer.token);

      h.server.offline = false;
      await tester.tap(find.text('Încearcă din nou'));
      await tester.pumpAndSettle();
      expect(find.text('Sold net'), findsOneWidget);
    });
  });

  group('sesiune expirată', () {
    testWidgets(
      '401 pe o cerere cu token: login, date locale șterse, explicație',
      (tester) async {
        final h = Harness()..signedInStore();
        await h.pump(tester);
        expect(find.text('Sold net'), findsOneWidget);

        h.server.sessionRevoked = true;
        await openProfile(tester);

        expect(find.text('Autentificare'), findsOneWidget);
        expect(find.text(sessionExpiredNotice), findsOneWidget);
        expect(h.memory.values.containsKey(StoreKeys.sessionToken), isFalse);
        expect(h.container.read(tokenHolderProvider).value, isNull);
        expect(h.container.read(hideAmountsProvider), isFalse);
        // Doar `session_expired` rămâne în coadă, pentru următoarea autentificare.
        final queued = h.container.read(usageTrackerProvider).queued;
        expect(
          queued.map((e) => e.name),
          everyElement(UsageEvents.sessionExpired),
        );
      },
    );

    testWidgets('session_expired se raportează după următoarea autentificare', (
      tester,
    ) async {
      final h = Harness()..signedInStore();
      await h.pump(tester);
      h.server.sessionRevoked = true;
      await openProfile(tester);
      expect(find.text('Autentificare'), findsOneWidget);

      h.server.sessionRevoked = false;
      await tester.login();
      expect(find.text('Sold net'), findsOneWidget);
      final names = h.server.allEvents.map((e) => e['name']);
      expect(names, containsAll(['session_expired', 'login', 'app_open']));
    });
  });

  group('deconectare', () {
    testWidgets('revocă sesiunea pe server și șterge datele locale', (
      tester,
    ) async {
      final h = Harness()..signedInStore();
      await h.pump(tester);
      await tester.tap(find.byTooltip('Ascunde sumele'));
      await tester.pumpAndSettle();
      expect(h.container.read(hideAmountsProvider), isTrue);

      await openProfile(tester);
      await tester.tapVisible(
        find.widgetWithText(OutlinedButton, 'Deconectare'),
      );
      await tester.tapVisible(
        find.widgetWithText(FilledButton, 'Deconectează-mă'),
      );

      expect(find.text('Autentificare'), findsOneWidget);
      final signOut = h.server.requestsTo('POST /api/auth/sign-out').toList();
      expect(signOut, hasLength(1));
      expect(
        signOut.single.headers['Authorization'],
        'Bearer ${FakeServer.token}',
      );
      // Nimic nu mai rămâne: token, coadă de evenimente, starea sumelor.
      expect(h.memory.values.containsKey(StoreKeys.sessionToken), isFalse);
      expect(h.container.read(tokenHolderProvider).value, isNull);
      expect(h.container.read(usageTrackerProvider).pending, 0);
      expect(h.container.read(hideAmountsProvider), isFalse);
      // `logout` a fost raportat înainte de revocare.
      expect(h.server.allEvents.map((e) => e['name']), contains('logout'));
    });

    testWidgets('fără rețea, telefonul tot se deconectează', (tester) async {
      final h = Harness()..signedInStore();
      await h.pump(tester);
      await openProfile(tester);
      h.server.offline = true;
      await tester.tapVisible(
        find.widgetWithText(OutlinedButton, 'Deconectare'),
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Deconectează-mă'));
      await tester.pump(const Duration(seconds: 10));
      await tester.pumpAndSettle();
      expect(find.text('Autentificare'), findsOneWidget);
      expect(h.memory.values.containsKey(StoreKeys.sessionToken), isFalse);
    });
  });

  group('gospodării', () {
    testWidgets('afișează gospodăriile și schimbă cea activă', (tester) async {
      final h = Harness()..signedInStore();
      await h.pump(tester);
      await openProfile(tester);
      expect(find.text('Ana Popescu'), findsOneWidget);
      expect(find.text('Casa Ana'), findsOneWidget);
      expect(find.text('Casa de vacanță'), findsOneWidget);

      await tester.tap(find.text('Casa de vacanță'));
      await tester.pumpAndSettle();
      expect(h.server.activeHousehold, FakeServer.hhTwo);
      final session = h.container.read(sessionProvider) as SignedIn;
      expect(session.profile.household?.name, 'Casa de vacanță');
    });
  });

  group('statistici de utilizare', () {
    testWidgets('după login se trimit evenimente, doar cu câmpurile permise', (
      tester,
    ) async {
      final h = Harness();
      await h.pump(tester);
      await tester.login();
      await tester.openTab('Rapoarte');
      await h.container.read(usageTrackerProvider).flush();

      expect(h.server.usageStatsGranted, isTrue);
      final events = h.server.allEvents;
      expect(events.map((e) => e['name']), containsAll(['login', 'app_open']));
      const allowed = {'name', 'screen', 'errorCode', 'occurredAt'};
      for (final e in events) {
        expect(allowed, containsAll(e.keys), reason: '$e');
        expect(e['occurredAt'], matches(RegExp(r'^\d{4}-\d\d-\d\dT.*Z$')));
      }
      expect(
        events.where((e) => e['name'] == 'screen_view').map((e) => e['screen']),
        contains('reports'),
      );
    });

    testWidgets('cu statisticile oprite nu se trimite nimic', (tester) async {
      final h = Harness(
        settings: const AppSettings(
          introSeen: true,
          usageStats: false,
          appLock: false,
        ),
      );
      await h.pump(tester);
      await tester.login();
      await tester.openTab('Rapoarte');
      await h.container.read(usageTrackerProvider).flush();
      expect(h.server.eventBatches, isEmpty);
      expect(h.server.usageStatsGranted, isFalse);
      expect(h.container.read(usageTrackerProvider).pending, 0);
    });

    testWidgets(
      'comutatorul din Setări revocă consimțământul și golește coada',
      (tester) async {
        final h = Harness();
        await h.pump(tester);
        await tester.login();
        expect(h.server.usageStatsGranted, isTrue);

        await tester.openTab('Mai mult');
        await tester.tap(find.text('Setări și confidențialitate'));
        await tester.pumpAndSettle();
        await tester.tap(
          find.widgetWithText(
            SwitchListTile,
            'Trimite statistici de utilizare',
          ),
        );
        await tester.pumpAndSettle();

        expect(h.server.usageStatsGranted, isFalse);
        expect(h.memory.values[StoreKeys.usageStats], '0');
        final tracker = h.container.read(usageTrackerProvider);
        expect(tracker.enabled, isFalse);
        expect(tracker.pending, 0);
      },
    );
  });
}

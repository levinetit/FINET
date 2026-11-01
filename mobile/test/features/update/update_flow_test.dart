import 'dart:async';

import 'package:finet_mobile/core/platform/url_opener.dart';
import 'package:finet_mobile/features/update/update_controller.dart';
import 'package:finet_mobile/features/update/update_info.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';

import '../../support/fake_server.dart';
import '../../support/fake_update.dart';
import '../../support/harness.dart';

/// Versiunea instalată în teste are `versionCode` 2 (`testClientInfo`).
Future<(Harness, FakeUpdate, List<Uri>)> start(
  WidgetTester tester, {
  Map<String, Object?>? release,
  UpdateInfo? cached,
  Harness? reuse,
}) async {
  final opened = <Uri>[];
  final overrides = <Override>[
    urlOpenerProvider.overrideWithValue((uri) async {
      opened.add(uri);
      return true;
    }),
    if (cached != null) initialUpdateProvider.overrideWithValue(cached),
  ];
  final h = Harness(overrides: overrides)..signedInStore();
  final upd = FakeUpdate(h.server)..release = release;
  await h.pump(tester);
  return (h, upd, opened);
}

void main() {
  group('actualizări în aplicație', () {
    testWidgets('versiune nouă: banner cu note, link HTTPS deschis la cerere', (
      tester,
    ) async {
      final (_, upd, opened) = await start(
        tester,
        release: FakeUpdate.version(),
      );
      expect(upd.calls, 1);
      expect(find.text('Versiune nouă disponibilă: 1.2.0'), findsOneWidget);
      expect(find.text('Scanare mai rapidă; corecturi.'), findsOneWidget);
      // Nimic nu se instalează singur: doar se deschide linkul.
      expect(opened, isEmpty);
      await tester.tap(find.widgetWithText(FilledButton, 'Descarcă'));
      await tester.pumpAndSettle();
      expect(opened.single.scheme, 'https');
      expect(opened.single.path, endsWith('finet-1.2.0.apk'));
    });

    testWidgets('„Mai târziu" ascunde bannerul pentru această versiune', (
      tester,
    ) async {
      await start(tester, release: FakeUpdate.version());
      await tester.tap(find.text('Mai târziu'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Versiune nouă disponibilă'), findsNothing);
    });

    testWidgets('aceeași versiune sau una mai veche: niciun banner', (
      tester,
    ) async {
      await start(tester, release: FakeUpdate.version(code: 2, name: '0.2.0'));
      expect(find.textContaining('Versiune nouă disponibilă'), findsNothing);
    });

    testWidgets('fără versiune publicată (404): aplicația merge normal', (
      tester,
    ) async {
      final (_, upd, _) = await start(tester);
      expect(upd.calls, 1);
      expect(find.textContaining('Versiune nouă disponibilă'), findsNothing);
      expect(find.text('Sold net (RON)'), findsOneWidget);
    });

    testWidgets('verificarea se face cel mult o dată pe zi', (tester) async {
      final (h, upd, _) = await start(tester, release: FakeUpdate.version());
      expect(upd.calls, 1);
      // A doua verificare în aceeași zi folosește rezultatul păstrat.
      unawaited(h.container.read(updateControllerProvider.notifier).check());
      await tester.pumpAndSettle();
      expect(upd.calls, 1);
    });

    testWidgets('sub versiunea minimă: ecran de actualizare, fără funcții', (
      tester,
    ) async {
      await start(tester, release: FakeUpdate.version(code: 20, min: 10));
      expect(find.text('Actualizare necesară'), findsWidgets);
      expect(find.textContaining('nu mai este acceptată'), findsOneWidget);
      expect(find.text('Sold net (RON)'), findsNothing);
      expect(find.byType(NavigationBar), findsNothing);
    });

    testWidgets(
      'versiune respinsă cunoscută din pornirea anterioară: nicio cerere financiară',
      (tester) async {
        final cached = UpdateInfo.fromJson(
          FakeUpdate.version(code: 20, min: 10),
        );
        final (h, _, _) = await start(
          tester,
          release: FakeUpdate.version(code: 20, min: 10),
          cached: cached,
        );
        expect(find.text('Actualizare necesară'), findsWidgets);
        expect(h.server.requestsTo('GET /api/v1/dashboard'), isEmpty);
        expect(h.server.requestsTo('GET /api/v1/accounts'), isEmpty);
      },
    );

    testWidgets('link care nu e HTTPS: răspunsul se ignoră', (tester) async {
      await start(
        tester,
        release: FakeUpdate.version(url: 'http://exemplu.test/finet.apk'),
      );
      expect(find.textContaining('Versiune nouă disponibilă'), findsNothing);
    });

    testWidgets('eroare de rețea la verificare: nu blochează nimic', (
      tester,
    ) async {
      final h = Harness()..signedInStore();
      FakeUpdate(h.server).release = FakeUpdate.version();
      h.server.on('GET /api/v1/app/android/latest', (o) {
        return finetError(500, 'internal', 'Eroare');
      });
      await h.pump(tester);
      expect(find.text('Sold net (RON)'), findsOneWidget);
    });
  });
}

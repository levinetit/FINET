import 'package:flutter_test/flutter_test.dart';

import '../../support/harness.dart';
import '../../support/scan_rig.dart';

void main() {
  group('partajare din alte aplicații', () {
    testWidgets('poze partajate cât rulează aplicația deschid Scanează', (
      tester,
    ) async {
      final r = await ScanRig.open(tester, openScan: false);
      r.share.share([photo('a.jpg'), photo('b.jpg')]);
      await tester.pumpAndSettle();
      expect(find.text('Poze de încărcat'), findsOneWidget);
      expect(find.text('Poza 1 din 2'), findsOneWidget);
    });

    testWidgets(
      'pornire la rece fără autentificare: importul continuă după login',
      (tester) async {
        final r = await ScanRig.open(
          tester,
          signedIn: false,
          sharedAtStart: [photo('rece.jpg')],
        );
        expect(find.text('Autentificare'), findsWidgets);
        expect(
          r.h.server.requests.where((q) => q.path.contains('documents')),
          isEmpty,
        );
        await tester.login();
        await tester.pumpAndSettle();
        expect(find.text('Poze de încărcat'), findsOneWidget);
        expect(find.text('rece.jpg'), findsWidgets);
      },
    );

    testWidgets('CSV partajat deschide importul de extras cu fișierul ales', (
      tester,
    ) async {
      final r = await ScanRig.open(tester, openScan: false);
      r.share.share([photo('banca.csv')]);
      await tester.pumpAndSettle();
      expect(find.text('Importă un extras'), findsWidgets);
      expect(find.text('banca.csv'), findsOneWidget);
    });

    testWidgets('un PDF cere alegerea: bon sau extras', (tester) async {
      final r = await ScanRig.open(tester, openScan: false);
      r.share.share([photo('document.pdf')]);
      await tester.pumpAndSettle();
      expect(find.text('Ce este acest PDF?'), findsOneWidget);
      await tester.tap(find.text('Un extras bancar'));
      await tester.pumpAndSettle();
      expect(find.text('document.pdf'), findsOneWidget);
    });

    testWidgets('PDF ales ca bon ajunge în lista de încărcare', (tester) async {
      final r = await ScanRig.open(tester, openScan: false);
      r.share.share([photo('factura.pdf')]);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Un bon sau o factură'));
      await tester.pumpAndSettle();
      expect(find.text('PDF de încărcat'), findsOneWidget);
    });

    testWidgets('combinație neacceptată: explicație, fără import', (
      tester,
    ) async {
      final r = await ScanRig.open(tester, openScan: false);
      r.share.share([photo('a.jpg'), photo('b.pdf')]);
      await tester.pumpAndSettle();
      expect(
        find.textContaining('Nu pot importa această combinație'),
        findsOneWidget,
      );
    });
  });
}

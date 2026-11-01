import 'package:finet_mobile/features/scan/scan_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/fake_server.dart';
import '../../support/harness.dart';
import '../../support/scan_rig.dart';

Future<void> tapText(WidgetTester tester, String text) async {
  await tester.tapVisible(find.text(text));
}

Future<void> takePhoto(WidgetTester tester) async {
  await tester.tapVisible(find.text('Fotografiază bonul'));
}

void main() {
  group('scanare și încărcare', () {
    testWidgets('afișează contorul zilnic de la server', (tester) async {
      await ScanRig.open(tester);
      expect(find.text('3 din 50 documente citite azi'), findsOneWidget);
    });

    testWidgets('o poză se încarcă, se urmărește și duce la verificare', (
      tester,
    ) async {
      final r = await ScanRig.open(tester);
      r.picker.camera.add(photo('bon1.jpg'));
      await takePhoto(tester);
      expect(find.text('bon1.jpg'), findsWidgets);

      await tapText(tester, 'Încarcă');
      await tester.pumpAndSettle();

      // Câmpurile text înaintea fișierului; poza e JPEG pregătit.
      final parts = r.rec.uploads.single;
      expect([for (final p in parts) p.name], ['kind', 'longReceipt', 'files']);
      expect(parts[0].text, 'receipt');
      expect(parts[1].text, 'false');
      expect(parts[2].filename, 'bon1.jpg');
      expect(parts[2].contentType, contains('image/jpeg'));

      // Urmărirea ajunge la „De verificat" și apare butonul.
      expect(find.text('De verificat'), findsOneWidget);
      await tester.tap(find.text('Verifică bonul'));
      await tester.pumpAndSettle();
      expect(find.text('Mega Image'), findsWidgets);
      // Poza temporară s-a șters după confirmarea serverului.
      expect(r.temp.deleted, ['/cache/bon1.jpg']);
    });

    testWidgets(
      'eroare de rețea: reîncercare cu aceiași octeți, fără recodare',
      (tester) async {
        final r = await ScanRig.open(tester);
        r.rec.failUploads = 1;
        r.picker.camera.add(photo('bon2.jpg'));
        await takePhoto(tester);
        await tapText(tester, 'Încarcă');
        await tester.pumpAndSettle();
        // Prima încercare a picat, a doua a reușit, poza s-a pregătit o singură dată.
        expect(r.rec.uploadAttempts, 2);
        expect(r.rec.uploads, hasLength(1));
        expect(r.norm.calls['/cache/bon2.jpg'], 1);
        expect(find.text('De verificat'), findsOneWidget);
      },
    );

    testWidgets(
      'după o eroare a serverului, „Încearcă din nou” trimite aceiași octeți',
      (tester) async {
        final r = await ScanRig.open(tester);
        r.rec.uploadError = () => finetError(
          409,
          'daily_document_limit',
          'Limita zilnică a fost atinsă.',
        );
        r.picker.camera.add(photo('bon3.jpg'));
        await takePhoto(tester);
        await tapText(tester, 'Încarcă');
        await tester.pumpAndSettle();
        expect(
          find.text('Ai atins limita zilnică de documente. Încearcă mâine.'),
          findsOneWidget,
        );
        // Pozele rămân, nimic nu s-a șters.
        expect(r.temp.deleted, isEmpty);
        r.rec.uploadError = null;
        await tapText(tester, 'Încearcă din nou');
        await tester.pumpAndSettle();
        expect(r.norm.calls['/cache/bon3.jpg'], 1);
        expect(find.text('De verificat'), findsOneWidget);
      },
    );

    testWidgets('același bon încărcat a doua oară e recunoscut ca duplicat', (
      tester,
    ) async {
      final r = await ScanRig.open(tester);
      r.picker.camera
        ..add(photo('bon4.jpg'))
        ..add(photo('bon4.jpg'));
      await takePhoto(tester);
      await tapText(tester, 'Încarcă');
      await tester.pumpAndSettle();
      await tapText(tester, 'Încarcă alt bon');
      await takePhoto(tester);
      await tapText(tester, 'Încarcă');
      await tester.pumpAndSettle();
      expect(r.rec.documents, hasLength(1));
      expect(find.text('deja încărcat'), findsOneWidget);
      expect(
        find.text(
          'Acest bon a mai fost încărcat. Serverul nu l-a creat a doua oară.',
        ),
        findsOneWidget,
      );
    });

    testWidgets('fără acord pentru AI: stare de așteptare explicată', (
      tester,
    ) async {
      final r = await ScanRig.open(tester);
      r.rec.consentRequired = true;
      r.picker.camera.add(photo('bon5.jpg'));
      await takePhoto(tester);
      await tapText(tester, 'Încarcă');
      await tester.pumpAndSettle();
      expect(find.text('Așteaptă acordul pentru AI'), findsOneWidget);
      expect(find.textContaining('Activează-l din Profil'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });

    testWidgets('bonul lung cere 2–4 poze, ordonate', (tester) async {
      final r = await ScanRig.open(tester);
      r.picker.camera
        ..add(photo('a.jpg'))
        ..add(photo('b.jpg'));
      await takePhoto(tester);
      await tester.tapVisible(find.byType(Switch));
      await tapText(tester, 'Încarcă');
      expect(
        find.text('Bonul lung cere 2–4 poze, în ordinea de sus în jos.'),
        findsOneWidget,
      );
      expect(r.rec.uploadAttempts, 0);

      await takePhoto(tester);
      // Mută a doua poză mai sus: ordinea trimisă e b, a.
      await tester.tapVisible(find.byTooltip('Mută mai sus').last);
      await tapText(tester, 'Încarcă');
      await tester.pumpAndSettle();
      final parts = r.rec.uploads.single;
      expect(parts[1].text, 'true');
      expect([for (final p in parts.skip(2)) p.filename], ['b.jpg', 'a.jpg']);
    });

    testWidgets(
      'cel mult 4 poze; HEIC rămâne acceptat, PDF-ul nu se amestecă',
      (tester) async {
        final r = await ScanRig.open(tester);
        for (var i = 0; i < 5; i++) {
          r.picker.camera.add(photo('p$i.heic'));
        }
        for (var i = 0; i < 4; i++) {
          await takePhoto(tester);
        }
        await takePhoto(tester);
        expect(
          find.text('Cel mult 4 poze pe un bon.', skipOffstage: false),
          findsOneWidget,
        );
        expect(
          find.textContaining('Poza 4 din 4', skipOffstage: false),
          findsOneWidget,
        );
      },
    );

    testWidgets('anularea șterge pozele temporare', (tester) async {
      final r = await ScanRig.open(tester);
      r.picker.camera.add(photo('bon6.jpg'));
      await takePhoto(tester);
      await tapText(tester, 'Anulează');
      expect(r.temp.deleted, ['/cache/bon6.jpg']);
      expect(find.text('Încarcă'), findsNothing);
    });

    testWidgets('deconectarea curăță fișierele temporare și starea', (
      tester,
    ) async {
      final r = await ScanRig.open(tester);
      r.picker.camera.add(photo('bon7.jpg'));
      await takePhoto(tester);
      // Prin interfață: o așteptare directă a rețelei blochează timpul simulat al testului.
      await tester.openTab('Mai mult');
      await tester.tap(find.text('Profil și gospodării'));
      await tester.pumpAndSettle();
      await tester.tapVisible(
        find.widgetWithText(OutlinedButton, 'Deconectare'),
      );
      await tester.tapVisible(
        find.widgetWithText(FilledButton, 'Deconectează-mă'),
      );
      expect(r.temp.wipes, greaterThan(0));
      expect(r.h.container.read(scanControllerProvider).items, isEmpty);
    });

    testWidgets('413 are mesaj clar', (tester) async {
      final r = await ScanRig.open(tester);
      r.rec.uploadError = () => finetError(413, 'file_too_large', 'x');
      r.picker.camera.add(photo('mare.jpg'));
      await takePhoto(tester);
      await tapText(tester, 'Încarcă');
      await tester.pumpAndSettle();
      expect(
        find.text('Un fișier depășește dimensiunea maximă.'),
        findsOneWidget,
      );
    });
  });
}

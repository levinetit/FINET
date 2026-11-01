import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/tokens.dart';
import '../../core/widgets/async_view.dart';
import '../../core/widgets/finet_scaffold.dart';
import '../receipts/models.dart';
import '../receipts/strings.dart';
import 'providers.dart';
import 'scan_controller.dart';

/// După încărcare: urmărește fiecare document până ajunge la „De verificat” (sau la o oprire
/// clară). `awaiting_consent` e o stare de așteptare, nu o încărcare: cere acordul utilizatorului.
class UploadStatusScreen extends ConsumerWidget {
  const UploadStatusScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final result = ref.watch(scanControllerProvider.select((s) => s.result));
    final controller = ref.read(scanControllerProvider.notifier);
    return PopScope(
      // Golirea rezultatului se amână: ieșirea din ecran poate avea loc în timpul construirii
      // arborelui, când providerii nu se pot modifica.
      onPopInvokedWithResult: (_, _) => Future<void>(controller.dismissResult),
      child: FinetScaffold(
        title: 'Starea încărcării',
        body: result == null
            ? const Center(child: Text('Nu există nicio încărcare.'))
            : ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (result.allDuplicates)
                    const Padding(
                      padding: EdgeInsets.only(bottom: 12),
                      child: Text(
                        'Acest bon a mai fost încărcat. Serverul nu l-a creat a doua oară.',
                      ),
                    ),
                  for (final d in result.documents) _DocumentCard(initial: d),
                  const SizedBox(height: 12),
                  OutlinedButton(
                    onPressed: () {
                      ref.read(scanControllerProvider.notifier).dismissResult();
                      context.go('/scan');
                    },
                    child: const Text('Încarcă alt bon'),
                  ),
                ],
              ),
      ),
    );
  }
}

class _DocumentCard extends ConsumerWidget {
  const _DocumentCard({required this.initial});

  final DocumentInfo initial;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final live = ref.watch(documentProvider(initial.id));
    // Până vine prima interogare, se arată starea din răspunsul de încărcare.
    final doc = live.asData?.value ?? initial;
    final c = context.finet;
    final inFlight = doc.status.inFlight && !live.hasError;
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                if (inFlight)
                  const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                else
                  Icon(_icon(doc.status), color: _color(c, doc.status)),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    doc.status.label,
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                ),
                if (initial.duplicate) const Chip(label: Text('deja încărcat')),
              ],
            ),
            if (live.hasError)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  errorMessage(live.error!),
                  style: TextStyle(color: c.bad),
                ),
              ),
            if (doc.status == DocumentStatus.awaitingConsent)
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: Text(
                  'Documentul așteaptă acordul tău pentru citirea cu AI. Activează-l din '
                  'Profil, în aplicația web FINET, sau introdu cheltuiala manual.',
                ),
              ),
            if (doc.status == DocumentStatus.failed ||
                doc.status == DocumentStatus.rejected)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(documentErrorText(doc.errorCode)),
              ),
            if (doc.possibleDuplicateOfId != null)
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: Text(
                  'Posibil duplicat al unui document încărcat înainte.',
                ),
              ),
            if (doc.receiptId != null &&
                (doc.status == DocumentStatus.needsReview ||
                    doc.status == DocumentStatus.done))
              Align(
                alignment: Alignment.centerRight,
                child: FilledButton(
                  onPressed: () => context.push('/receipts/${doc.receiptId}'),
                  child: Text(
                    doc.status == DocumentStatus.done
                        ? 'Vezi bonul'
                        : 'Verifică bonul',
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  static IconData _icon(DocumentStatus s) => switch (s) {
    DocumentStatus.needsReview => Icons.fact_check_outlined,
    DocumentStatus.done => Icons.check_circle_outline,
    DocumentStatus.failed || DocumentStatus.rejected => Icons.error_outline,
    DocumentStatus.awaitingConsent => Icons.pause_circle_outline,
    _ => Icons.hourglass_empty,
  };

  static Color _color(FinetColors c, DocumentStatus s) => switch (s) {
    DocumentStatus.done => c.ok,
    DocumentStatus.failed || DocumentStatus.rejected => c.bad,
    DocumentStatus.needsReview => c.warn,
    _ => c.muted,
  };
}

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/money/format.dart';
import '../../core/network/api_error.dart';
import '../../core/state/privacy.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/amount_text.dart';
import '../finance/providers.dart';
import '../scan/providers.dart';
import 'models.dart';
import 'providers.dart';

/// Tranzacțiile din extras propuse pentru un bon: sumă exactă, cel mult 3 zile. „Este aceasta”
/// leagă bonul de tranzacție (fără tranzacție nouă; serverul poate scoate dubla creată de bon);
/// „Nu este” respinge propunerea. Potrivirile le calculează serverul.
class MatchPanel extends ConsumerStatefulWidget {
  const MatchPanel({super.key, required this.matches, this.onDecided});

  final ReceiptMatches matches;

  /// Apelată după o decizie reușită (de exemplu, ca ecranul să se reîmprospăteze).
  final VoidCallback? onDecided;

  @override
  ConsumerState<MatchPanel> createState() => _MatchPanelState();
}

class _MatchPanelState extends ConsumerState<MatchPanel> {
  bool _busy = false;
  String? _notice;

  Future<void> _decide(MatchCandidate c, {required bool confirm}) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _notice = null;
    });
    try {
      final result = await ref
          .read(receiptsApiProvider)
          .decideMatch(
            widget.matches.receiptId,
            transactionId: c.transactionId,
            confirm: confirm,
          );
      if (confirm) {
        // Legarea poate scoate tranzacția dublură creată de bon: cifrele se cer din nou.
        if (result.removedTransactionId != null) {
          invalidateFinance(ref.invalidate);
          await ref.read(transactionsProvider.notifier).refresh();
        }
      }
      ref.invalidate(matchQueueProvider);
      ref.invalidate(receiptMatchesProvider(widget.matches.receiptId));
      if (!mounted) return;
      setState(
        () => _notice = confirm
            ? 'Bonul a fost legat de tranzacția din extras.'
            : 'Propunerea a fost respinsă și nu se mai arată.',
      );
      widget.onDecided?.call();
    } on ApiError catch (e) {
      if (mounted) setState(() => _notice = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final hidden = ref.watch(hideAmountsProvider);
    final m = widget.matches;
    final c = context.finet;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Tranzacții din extras potrivite',
          style: Theme.of(context).textTheme.titleMedium,
        ),
        if (m.ambiguous)
          const Padding(
            padding: EdgeInsets.only(top: 4),
            child: Text(
              'Mai multe tranzacții se potrivesc la fel de bine: alege-o pe cea corectă.',
            ),
          ),
        if (_notice != null)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(_notice!, style: TextStyle(color: c.muted)),
          ),
        for (final cand in m.candidates)
          Card(
            margin: const EdgeInsets.only(top: 8),
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    cand.description ?? 'Fără descriere',
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  Text(
                    '${formatDate(cand.occurredOn)} · ${displayMoney(cand.amount, hidden: hidden)}',
                  ),
                  if (cand.probable)
                    const Padding(
                      padding: EdgeInsets.only(top: 4),
                      child: Chip(label: Text('Potrivire probabilă')),
                    ),
                  Text(
                    [for (final r in cand.reasons) matchReasonText[r] ?? r]
                        .join(' · '),
                    style: TextStyle(color: c.muted),
                  ),
                  OverflowBar(
                    alignment: MainAxisAlignment.end,
                    children: [
                      TextButton(
                        onPressed: _busy
                            ? null
                            : () => _decide(cand, confirm: false),
                        child: const Text('Nu este'),
                      ),
                      FilledButton(
                        onPressed: _busy
                            ? null
                            : () => _decide(cand, confirm: true),
                        child: const Text('Este aceasta'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

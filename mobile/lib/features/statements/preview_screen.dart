import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:uuid/uuid.dart';

import '../../core/money/format.dart';
import '../../core/money/money.dart';
import '../../core/network/api_error.dart';
import '../../core/state/privacy.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/amount_text.dart';
import '../../core/widgets/async_view.dart';
import '../../core/widgets/finet_scaffold.dart';
import '../finance/providers.dart';
import '../usage/usage_tracker.dart';
import '../../core/providers.dart';
import 'models.dart';
import 'providers.dart';
import 'statements_api.dart';

/// Previzualizarea (sau rezultatul) unui import. Duplicatele și verificarea soldurilor sunt
/// stabilite de server. Rândurile de schimb valutar cer o decizie explicită; transferul între
/// conturi se face din aplicația web.
class StatementPreviewScreen extends ConsumerWidget {
  const StatementPreviewScreen({super.key, required this.importId});

  final String importId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detail = ref.watch(importDetailProvider(importId));
    return FinetScaffold(
      title: 'Extras',
      body: AsyncView<StatementImport>(
        value: detail,
        onRetry: () => ref.invalidate(importDetailProvider(importId)),
        data: (imp) => _Preview(key: ValueKey(imp.id), initial: imp),
      ),
    );
  }
}

class _Preview extends ConsumerStatefulWidget {
  const _Preview({super.key, required this.initial});

  final StatementImport initial;

  @override
  ConsumerState<_Preview> createState() => _PreviewState();
}

class _PreviewState extends ConsumerState<_Preview> {
  late StatementImport _imp = widget.initial;
  final Map<int, FxChoice> _fx = {};
  bool _ack = false;
  bool _busy = false;
  String? _error;
  String? _info;
  String _key = const Uuid().v4();

  bool get _needsFxChoice => _imp.fxLines.any((l) => !_fx.containsKey(l.rowNo));

  Future<void> _confirm() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final done = await ref
          .read(statementsApiProvider)
          .confirm(
            _imp.id,
            idempotencyKey: _key,
            acknowledgeBalanceMismatch: _ack,
            fx: _fx,
          );
      ref.read(usageTrackerProvider).track(UsageEvents.statementImported);
      invalidateFinance(ref.invalidate);
      ref.invalidate(coverageProvider);
      ref.invalidate(importsProvider);
      ref.invalidate(importDetailProvider(_imp.id));
      await ref.read(transactionsProvider.notifier).refresh();
      if (!mounted) return;
      setState(() {
        _imp = done;
        _info = 'Extrasul a fost importat: ${done.importedCount} tranzacții.';
      });
    } on ApiError catch (e) {
      ref.read(usageTrackerProvider).error(e);
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<bool> _ask(String title, String body, String action) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: Text(body),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Nu'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(action),
          ),
        ],
      ),
    );
    return ok ?? false;
  }

  Future<void> _discard() async {
    if (!await _ask(
      'Renunți la previzualizare?',
      'Se șterg previzualizarea și fișierul sursă. Nu se importă nimic.',
      'Renunță',
    )) {
      return;
    }
    await _run(() async {
      await ref.read(statementsApiProvider).discard(_imp.id);
      ref.invalidate(importsProvider);
      if (mounted) context.pop();
    });
  }

  Future<void> _cancelImport() async {
    if (!await _ask(
      'Anulezi importul?',
      'Se șterg DOAR tranzacțiile create de acest import.',
      'Anulează importul',
    )) {
      return;
    }
    await _run(() async {
      await ref.read(statementsApiProvider).cancel(_imp.id);
      invalidateFinance(ref.invalidate);
      ref.invalidate(coverageProvider);
      ref.invalidate(importsProvider);
      await ref.read(transactionsProvider.notifier).refresh();
      if (mounted) context.pop();
    });
  }

  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final imp = _imp;
    final hidden = ref.watch(hideAmountsProvider);
    final c = context.finet;
    String money(Money? m) => m == null ? '—' : displayMoney(m, hidden: hidden);
    final previewed = imp.status == ImportStatus.previewed;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(
          '${imp.bank.toUpperCase()} · ${imp.format.toUpperCase()} · ${imp.status.label}',
          style: Theme.of(context).textTheme.titleMedium,
        ),
        if (imp.periodStart != null && imp.periodEnd != null)
          Text(
            'Perioada: ${formatDate(imp.periodStart!)} – ${formatDate(imp.periodEnd!)}',
          ),
        const SizedBox(height: 8),
        Text('Sold inițial: ${money(imp.openingBalance)}'),
        Text('Sold final în extras: ${money(imp.closingBalance)}'),
        Text('Sold final calculat: ${money(imp.computedClosing)}'),
        const SizedBox(height: 8),
        Text(
          '${imp.newCount} rânduri noi · ${imp.duplicateCount} duplicate · '
          '${imp.lineCount} în total',
        ),
        for (final w in imp.warnings)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(w, style: TextStyle(color: c.warn)),
          ),
        if (imp.balanceMismatch)
          Card(
            color: c.warn.withValues(alpha: 0.12),
            margin: const EdgeInsets.only(top: 12),
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Soldurile extrasului nu se potrivesc cu rândurile citite. '
                    'Verifică extrasul înainte să importi.',
                  ),
                  if (previewed)
                    CheckboxListTile(
                      contentPadding: EdgeInsets.zero,
                      value: _ack,
                      onChanged: (v) => setState(() => _ack = v ?? false),
                      title: const Text('Am verificat, importă oricum'),
                    ),
                ],
              ),
            ),
          ),
        const Divider(height: 24),
        for (final line in imp.lines)
          _LineTile(
            line: line,
            hidden: hidden,
            choice: _fx[line.rowNo],
            decide: previewed && line.isFx && line.state == LineState.fresh
                ? (v) => setState(() {
                    if (v == null) {
                      _fx.remove(line.rowNo);
                    } else {
                      _fx[line.rowNo] = v;
                    }
                    _key = const Uuid().v4();
                  })
                : null,
          ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(_error!, style: TextStyle(color: c.bad)),
          ),
        if (_info != null)
          Padding(padding: const EdgeInsets.only(top: 8), child: Text(_info!)),
        const SizedBox(height: 12),
        if (previewed) ...[
          if (_needsFxChoice)
            const Padding(
              padding: EdgeInsets.only(bottom: 8),
              child: Text(
                'Alege ce se întâmplă cu fiecare schimb valutar. Transferul între conturi '
                'se face din aplicația web.',
              ),
            ),
          FilledButton(
            onPressed: _busy || _needsFxChoice || (imp.balanceMismatch && !_ack)
                ? null
                : _confirm,
            child: const Text('Confirmă importul'),
          ),
          TextButton(
            onPressed: _busy ? null : _discard,
            child: const Text('Renunță'),
          ),
        ] else if (imp.status == ImportStatus.imported)
          TextButton(
            onPressed: _busy ? null : _cancelImport,
            child: Text('Anulează importul', style: TextStyle(color: c.bad)),
          ),
      ],
    );
  }
}

class _LineTile extends StatelessWidget {
  const _LineTile({
    required this.line,
    required this.hidden,
    required this.choice,
    required this.decide,
  });

  final StatementLine line;
  final bool hidden;
  final FxChoice? choice;
  final ValueChanged<FxChoice?>? decide;

  @override
  Widget build(BuildContext context) {
    final c = context.finet;
    final amount = displayMoney(line.amount, hidden: hidden);
    final sign = hidden ? '' : (line.credit ? '+ ' : '− ');
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  line.description,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(width: 8),
              Text(
                '$sign$amount',
                style: TextStyle(color: line.credit ? c.ok : c.bad),
              ),
            ],
          ),
          Text(
            '${formatDate(line.occurredOn)} · ${line.state.label}'
            '${line.isFx ? ' · schimb valutar' : ''}',
            style: TextStyle(color: c.muted),
          ),
          if (decide != null)
            DropdownButtonFormField<FxChoice>(
              isExpanded: true,
              initialValue: choice,
              decoration: const InputDecoration(
                labelText: 'Ce faci cu schimbul valutar?',
              ),
              items: [
                for (final f in FxChoice.values)
                  DropdownMenuItem(value: f, child: Text(f.label)),
              ],
              onChanged: decide,
            ),
        ],
      ),
    );
  }
}

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../core/money/format.dart';
import '../../core/network/api_error.dart';
import '../../core/providers.dart';
import '../../core/state/privacy.dart';
import '../../core/theme/theme.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/amount_text.dart';
import '../../core/widgets/async_view.dart';
import '../../core/widgets/finet_scaffold.dart';
import '../../core/widgets/states.dart';
import '../finance/models.dart';
import '../finance/providers.dart';
import '../usage/usage_tracker.dart';
import 'models.dart';
import 'providers.dart';

/// Plăți recurente: reguli cu starea, pauză și reluare, „Generează acum” și propunerile detectate
/// de server. Scadențele și contoarele le calculează serverul; aici doar se afișează.
class RecurringScreen extends ConsumerStatefulWidget {
  const RecurringScreen({super.key});

  @override
  ConsumerState<RecurringScreen> createState() => _RecurringScreenState();
}

class _RecurringScreenState extends ConsumerState<RecurringScreen> {
  RecurringStatus? _filter;
  bool _busy = false;

  void _snack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  /// Rulează o acțiune care schimbă datele: arată eroarea serverului, nu o înghite.
  Future<bool> _run(Future<void> Function() action) async {
    if (_busy) return false;
    setState(() => _busy = true);
    try {
      await action();
      return true;
    } on ApiError catch (e) {
      ref.read(usageTrackerProvider).error(e);
      _snack(e.message);
      return false;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _afterWrite() {
    ref.invalidate(recurringListProvider);
    ref.invalidate(recurringSuggestionsProvider);
    invalidateFinance(ref.invalidate);
    ref.read(transactionsProvider.notifier).refresh();
  }

  Future<void> _generate() async {
    // O singură cheie per apăsare: o reîncercare automată o refolosește, o apăsare nouă are alta.
    final key = const Uuid().v4();
    GenerateResult? result;
    final ok = await _run(() async {
      result = await ref
          .read(recurringApiProvider)
          .generate(idempotencyKey: key);
    });
    final r = result;
    if (!ok || r == null) return;
    ref.read(usageTrackerProvider).track(UsageEvents.recurringGenerated);
    _afterWrite();
    _snack(
      r.generated == 0 && r.failed == 0
          ? 'Nicio plată scadentă acum.'
          : 'Generate: ${r.generated}. Eșuate: ${r.failed}. Sărite: ${r.skipped}.',
    );
  }

  Future<void> _togglePause(RecurringRule rule) async {
    final api = ref.read(recurringApiProvider);
    final ok = await _run(
      () async => rule.status == RecurringStatus.paused
          ? await api.resume(rule.id)
          : await api.pause(rule.id),
    );
    if (ok) ref.invalidate(recurringListProvider);
  }

  @override
  Widget build(BuildContext context) {
    final list = ref.watch(recurringListProvider);
    return FinetScaffold(
      title: 'Plăți recurente',
      screen: UsageScreens.recurring,
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(recurringListProvider);
          ref.invalidate(recurringSuggestionsProvider);
          await ref.read(recurringListProvider.future);
        },
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            AsyncView<RecurringList>(
              value: list,
              onRetry: () => ref.invalidate(recurringListProvider),
              data: (data) => _Body(
                data: data,
                filter: _filter,
                busy: _busy,
                onFilter: (f) => setState(() => _filter = f),
                onGenerate: _generate,
                onTogglePause: _togglePause,
              ),
            ),
            const SizedBox(height: 16),
            _Suggestions(busy: _busy, run: _run, onChanged: _afterWrite),
          ],
        ),
      ),
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({
    required this.data,
    required this.filter,
    required this.busy,
    required this.onFilter,
    required this.onGenerate,
    required this.onTogglePause,
  });

  final RecurringList data;
  final RecurringStatus? filter;
  final bool busy;
  final ValueChanged<RecurringStatus?> onFilter;
  final VoidCallback onGenerate;
  final ValueChanged<RecurringRule> onTogglePause;

  @override
  Widget build(BuildContext context) {
    final rules = filter == null
        ? data.rules
        : [
            for (final r in data.rules)
              if (r.status == filter) r,
          ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '${data.counts.active} active · ${data.counts.due} scadente · ${data.counts.total} în total',
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            FilledButton.icon(
              onPressed: busy ? null : onGenerate,
              icon: const Icon(Icons.play_arrow),
              label: const Text('Generează acum'),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          children: [
            ChoiceChip(
              label: const Text('Toate'),
              selected: filter == null,
              onSelected: (_) => onFilter(null),
            ),
            for (final s in RecurringStatus.values)
              ChoiceChip(
                label: Text(s.label),
                selected: filter == s,
                onSelected: (_) => onFilter(s),
              ),
          ],
        ),
        const SizedBox(height: 8),
        if (rules.isEmpty)
          const EmptyState(
            title: 'Nicio plată recurentă',
            message: 'Regulile noi se creează din aplicația web. Aici apar cele existente.',
          )
        else
          for (final rule in rules)
            _RuleCard(
              rule: rule,
              busy: busy,
              onTogglePause: () => onTogglePause(rule),
            ),
      ],
    );
  }
}

class _RuleCard extends ConsumerWidget {
  const _RuleCard({
    required this.rule,
    required this.busy,
    required this.onTogglePause,
  });

  final RecurringRule rule;
  final bool busy;
  final VoidCallback onTogglePause;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hidden = ref.watch(hideAmountsProvider);
    final c = context.finet;
    final amount = displayMoney(rule.amount, hidden: hidden);
    final sign = rule.type == TxType.income ? '+' : '−';
    final canToggle = rule.status != RecurringStatus.completed;
    final paused = rule.status == RecurringStatus.paused;
    return Card(
      margin: const EdgeInsets.only(top: 8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Semantics(
          container: true,
          label:
              '${rule.description}, ${rule.type.label}, $amount, ${rule.frequencyLabel}, '
              '${rule.status.label}${rule.due ? ', scadentă' : ''}',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      rule.description,
                      style: Theme.of(context).textTheme.titleSmall,
                    ),
                  ),
                  Text(
                    hidden ? amount : '$sign $amount',
                    style: amountStyle(15, bold: true).copyWith(
                      color: rule.type == TxType.income ? c.ok : c.bad,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                '${rule.frequencyLabel} · următoarea: ${formatDate(rule.nextRunOn)}',
              ),
              const SizedBox(height: 4),
              Wrap(
                spacing: 8,
                runSpacing: 4,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Chip(label: Text(rule.status.label)),
                  if (rule.due) const Chip(label: Text('Scadentă')),
                  if (rule.lastErrorCode != null)
                    Chip(
                      label: Text('Ultima generare a eșuat'),
                      avatar: Icon(Icons.error_outline, color: c.bad),
                    ),
                ],
              ),
              if (canToggle)
                Align(
                  alignment: Alignment.centerRight,
                  child: TextButton.icon(
                    onPressed: busy ? null : onTogglePause,
                    icon: Icon(paused ? Icons.play_arrow : Icons.pause),
                    label: Text(paused ? 'Reia' : 'Pauză'),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Suggestions extends ConsumerWidget {
  const _Suggestions({
    required this.busy,
    required this.run,
    required this.onChanged,
  });

  final bool busy;
  final Future<bool> Function(Future<void> Function()) run;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hidden = ref.watch(hideAmountsProvider);
    final value = ref.watch(recurringSuggestionsProvider);
    // Propunerile sunt un bonus: dacă nu se pot încărca, lista de reguli rămâne utilă.
    final items = value.asData?.value ?? const <RecurringSuggestion>[];
    if (items.isEmpty) return const SizedBox.shrink();
    final api = ref.read(recurringApiProvider);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Propuneri detectate',
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 4),
        const Text(
          'Plăți care se repetă în istoricul tău. Nu se creează nimic fără acordul tău.',
        ),
        for (final s in items)
          Card(
            margin: const EdgeInsets.only(top: 8),
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    s.merchant ?? s.description,
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  Text(
                    '${displayMoney(s.amount, hidden: hidden)} · ${s.frequency.label} · '
                    '${s.occurrences} apariții · ${s.accountName}',
                  ),
                  OverflowBar(
                    alignment: MainAxisAlignment.end,
                    children: [
                      TextButton(
                        onPressed: busy
                            ? null
                            : () async {
                                final ok = await run(
                                  () => api.dismissSuggestion(s.signature),
                                );
                                if (ok) onChanged();
                              },
                        child: const Text('Respinge'),
                      ),
                      FilledButton(
                        onPressed: busy
                            ? null
                            : () async {
                                final key = const Uuid().v4();
                                final ok = await run(
                                  () => api.acceptSuggestion(
                                    s.signature,
                                    idempotencyKey: key,
                                  ),
                                );
                                if (ok) onChanged();
                              },
                        child: const Text('Acceptă'),
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

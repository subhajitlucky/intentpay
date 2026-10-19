import React, { useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  History,
  Send,
  ShieldAlert,
  ShieldCheck
} from 'lucide-react';

const TYPE_MAP = {
  send: { label: 'Send', Icon: ArrowUpRight },
  receive: { label: 'Receive', Icon: ArrowDownLeft },
  guardrail: { label: 'Guardrail', Icon: ShieldCheck },
  security: { label: 'Security', Icon: ShieldAlert }
};

const STATUS_CLASS = {
  success: 'status--success',
  failed: 'status--failed',
  pending: 'status--pending'
};

function shortAddress(value) {
  const text = String(value || '');
  if (!text) return 'unknown';
  if (text.startsWith('@') || text.length <= 20) return text;
  return `${text.slice(0, 10)}…${text.slice(-6)}`;
}

function formatWhen(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * The transaction history as a statement rather than a feed of cards:
 * fixed columns, tabular figures, right-aligned amounts, one status chip.
 */
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'out', label: 'Out' },
  { id: 'in', label: 'In' }
];

function matchesFilter(tx, filter) {
  if (filter === 'in') return tx.type === 'receive';
  if (filter === 'out') return tx.type !== 'receive';
  return true;
}

export default function TransactionLedger({ transactions = [] }) {
  const [filter, setFilter] = useState('all');
  const count = transactions.length;

  // Counts are per filter so the chips double as a summary of the ledger.
  const counts = useMemo(() => ({
    all: count,
    out: transactions.filter((tx) => matchesFilter(tx, 'out')).length,
    in: transactions.filter((tx) => matchesFilter(tx, 'in')).length
  }), [transactions, count]);

  const visible = useMemo(
    () => transactions.filter((tx) => matchesFilter(tx, filter)),
    [transactions, filter]
  );

  return (
    <section className="panel reveal reveal--4" aria-label="Transaction ledger">
      <div className="panel__head">
        <span className="panel__title">
          <History size={15} />
          Transaction ledger
        </span>
        <span className="panel__meta">
          {count > 0 ? `${count} record${count === 1 ? '' : 's'}` : 'empty'}
        </span>
      </div>

      {count === 0 ? (
        <div className="ledger__empty">
          <span className="ledger__empty-icon">
            <Send size={16} />
          </span>
          <span className="ledger__empty-title">No settlements yet</span>
          <p className="ledger__empty-hint">
            Ask the assistant for a transfer — “send 0.01 ETH to @alice” — and it will be
            listed here once you approve it.
          </p>
        </div>
      ) : (
        <>
          <div className="ledger__filters" role="group" aria-label="Filter transactions">
            {FILTERS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`chip${filter === option.id ? ' is-active' : ''}`}
                onClick={() => setFilter(option.id)}
                aria-pressed={filter === option.id}
              >
                {option.label}
                <span className="chip__count">{counts[option.id]}</span>
              </button>
            ))}
          </div>

          <div className="ledger__head" aria-hidden="true">
            <span>Type</span>
            <span>Counterparty</span>
            <span style={{ textAlign: 'right' }}>Amount</span>
            <span style={{ textAlign: 'right' }}>Status</span>
          </div>
          <div className="ledger__body">
            {visible.length === 0 && (
              <p className="rail__empty">No transactions match this filter.</p>
            )}
            {visible.map((tx, index) => {
              const { label, Icon } = TYPE_MAP[tx.type] || TYPE_MAP.send;
              const isIncoming = tx.type === 'receive';
              return (
                <div
                  key={`${tx.hash || tx.timestamp || 'tx'}-${index}`}
                  className={`ledger__row${isIncoming ? ' ledger__row--in' : ''}`}
                >
                  <span className="ledger__type">
                    <Icon size={13} />
                    {label}
                  </span>

                  <span className="ledger__party">
                    <span className="ledger__party-main">{shortAddress(tx.to)}</span>
                    <span className="ledger__party-sub">
                      {formatWhen(tx.timestamp)} · {tx.mode || 'custodial'}
                    </span>
                  </span>

                  <span className="ledger__amount">
                    {tx.amount}
                    <span>ETH</span>
                  </span>

                  <span className="ledger__status-cell">
                    <span className={`status ${STATUS_CLASS[tx.status] || 'status--pending'}`}>
                      {tx.status || 'pending'}
                    </span>
                  </span>

                  {tx.hash && <span className="ledger__note">tx {tx.hash}</span>}
                  {tx.error && (
                    <span className="ledger__note ledger__note--error">error {tx.error}</span>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

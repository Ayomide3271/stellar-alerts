import { describe, expect, it } from 'vitest';
import {
  streamTuiReducer,
  type StreamTuiState,
  type StreamTuiAction,
} from './stream-tui.js';
import { PaymentDTO } from '../lib/types.js';

describe('streamTuiReducer (#645)', () => {
  const initialState: StreamTuiState = {
    payments: [],
    isPaused: false,
    filter: '',
    totalReceived: 0,
    connectionStatus: 'connecting',
    lastUpdate: new Date().toISOString(),
  };

  const mockPayment: PaymentDTO = {
    id: 'test-payment-1',
    walletId: 'wallet-1',
    fromAddress: 'GABCDEFGHIJKLMN',
    toAddress: 'GXYZ1234567890',
    amount: '100.5',
    asset: 'XLM',
    memo: 'test memo',
    receivedAt: new Date().toISOString(),
  };

  describe('ADD_PAYMENT action', () => {
    it('adds a payment to the state', () => {
      const action: StreamTuiAction = { type: 'ADD_PAYMENT', payload: mockPayment };
      const newState = streamTuiReducer(initialState, action);

      expect(newState.payments).toHaveLength(1);
      expect(newState.payments[0]).toEqual(mockPayment);
      expect(newState.totalReceived).toBe(1);
    });

    it('increments total received count', () => {
      const stateWithPayments: StreamTuiState = {
        ...initialState,
        payments: [mockPayment],
        totalReceived: 1,
      };

      const action: StreamTuiAction = { type: 'ADD_PAYMENT', payload: { ...mockPayment, id: 'test-payment-2' } };
      const newState = streamTuiReducer(stateWithPayments, action);

      expect(newState.totalReceived).toBe(2);
    });

    it('limits payments to last 50', () => {
      const stateWithManyPayments: StreamTuiState = {
        ...initialState,
        payments: Array.from({ length: 50 }, (_, i) => ({
          ...mockPayment,
          id: `payment-${i}`,
        })),
        totalReceived: 50,
      };

      const action: StreamTuiAction = { type: 'ADD_PAYMENT', payload: { ...mockPayment, id: 'payment-51' } };
      const newState = streamTuiReducer(stateWithManyPayments, action);

      expect(newState.payments).toHaveLength(50);
      expect(newState.payments[0].id).toBe('payment-51');
      expect(newState.payments[49].id).toBe('payment-1');
    });

    it('updates lastUpdate timestamp', () => {
      const oldTimestamp = initialState.lastUpdate;
      const action: StreamTuiAction = { type: 'ADD_PAYMENT', payload: mockPayment };
      const newState = streamTuiReducer(initialState, action);

      expect(newState.lastUpdate).not.toBe(oldTimestamp);
    });
  });

  describe('TOGGLE_PAUSE action', () => {
    it('toggles isPaused from false to true', () => {
      const action: StreamTuiAction = { type: 'TOGGLE_PAUSE' };
      const newState = streamTuiReducer(initialState, action);

      expect(newState.isPaused).toBe(true);
    });

    it('toggles isPaused from true to false', () => {
      const pausedState: StreamTuiState = { ...initialState, isPaused: true };
      const action: StreamTuiAction = { type: 'TOGGLE_PAUSE' };
      const newState = streamTuiReducer(pausedState, action);

      expect(newState.isPaused).toBe(false);
    });

    it('updates lastUpdate timestamp', () => {
      const oldTimestamp = initialState.lastUpdate;
      const action: StreamTuiAction = { type: 'TOGGLE_PAUSE' };
      const newState = streamTuiReducer(initialState, action);

      expect(newState.lastUpdate).not.toBe(oldTimestamp);
    });
  });

  describe('SET_FILTER action', () => {
    it('sets the filter string', () => {
      const action: StreamTuiAction = { type: 'SET_FILTER', payload: 'XLM' };
      const newState = streamTuiReducer(initialState, action);

      expect(newState.filter).toBe('XLM');
    });

    it('clears the filter when empty string is passed', () => {
      const stateWithFilter: StreamTuiState = { ...initialState, filter: 'XLM' };
      const action: StreamTuiAction = { type: 'SET_FILTER', payload: '' };
      const newState = streamTuiReducer(stateWithFilter, action);

      expect(newState.filter).toBe('');
    });

    it('updates lastUpdate timestamp', () => {
      const oldTimestamp = initialState.lastUpdate;
      const action: StreamTuiAction = { type: 'SET_FILTER', payload: 'test' };
      const newState = streamTuiReducer(initialState, action);

      expect(newState.lastUpdate).not.toBe(oldTimestamp);
    });
  });

  describe('CLEAR action', () => {
    it('clears all payments from state', () => {
      const stateWithPayments: StreamTuiState = {
        ...initialState,
        payments: [mockPayment, { ...mockPayment, id: 'payment-2' }],
        totalReceived: 2,
      };

      const action: StreamTuiAction = { type: 'CLEAR' };
      const newState = streamTuiReducer(stateWithPayments, action);

      expect(newState.payments).toHaveLength(0);
      expect(newState.totalReceived).toBe(2); // totalReceived is not reset
    });

    it('updates lastUpdate timestamp', () => {
      const stateWithPayments: StreamTuiState = {
        ...initialState,
        payments: [mockPayment],
      };

      const oldTimestamp = stateWithPayments.lastUpdate;
      const action: StreamTuiAction = { type: 'CLEAR' };
      const newState = streamTuiReducer(stateWithPayments, action);

      expect(newState.lastUpdate).not.toBe(oldTimestamp);
    });
  });

  describe('SET_CONNECTION_STATUS action', () => {
    it('sets connection status to connected', () => {
      const action: StreamTuiAction = { type: 'SET_CONNECTION_STATUS', payload: 'connected' };
      const newState = streamTuiReducer(initialState, action);

      expect(newState.connectionStatus).toBe('connected');
    });

    it('sets connection status to disconnected', () => {
      const action: StreamTuiAction = { type: 'SET_CONNECTION_STATUS', payload: 'disconnected' };
      const newState = streamTuiReducer(initialState, action);

      expect(newState.connectionStatus).toBe('disconnected');
    });

    it('sets connection status to connecting', () => {
      const action: StreamTuiAction = { type: 'SET_CONNECTION_STATUS', payload: 'connecting' };
      const newState = streamTuiReducer(initialState, action);

      expect(newState.connectionStatus).toBe('connecting');
    });

    it('updates lastUpdate timestamp', () => {
      const oldTimestamp = initialState.lastUpdate;
      const action: StreamTuiAction = { type: 'SET_CONNECTION_STATUS', payload: 'connected' };
      const newState = streamTuiReducer(initialState, action);

      expect(newState.lastUpdate).not.toBe(oldTimestamp);
    });
  });

  describe('QUIT action', () => {
    it('returns state unchanged', () => {
      const action: StreamTuiAction = { type: 'QUIT' };
      const newState = streamTuiReducer(initialState, action);

      expect(newState).toEqual(initialState);
    });
  });

  describe('unknown action', () => {
    it('returns state unchanged for unknown action types', () => {
      const action = { type: 'UNKNOWN_ACTION' } as any;
      const newState = streamTuiReducer(initialState, action);

      expect(newState).toEqual(initialState);
    });
  });

  describe('complex state transitions', () => {
    it('handles multiple actions in sequence', () => {
      let state = initialState;

      // Add payment
      state = streamTuiReducer(state, { type: 'ADD_PAYMENT', payload: mockPayment });
      expect(state.payments).toHaveLength(1);
      expect(state.totalReceived).toBe(1);

      // Toggle pause
      state = streamTuiReducer(state, { type: 'TOGGLE_PAUSE' });
      expect(state.isPaused).toBe(true);

      // Set filter
      state = streamTuiReducer(state, { type: 'SET_FILTER', payload: 'XLM' });
      expect(state.filter).toBe('XLM');

      // Add another payment
      state = streamTuiReducer(state, { type: 'ADD_PAYMENT', payload: { ...mockPayment, id: 'payment-2' } });
      expect(state.payments).toHaveLength(2);
      expect(state.totalReceived).toBe(2);

      // Clear
      state = streamTuiReducer(state, { type: 'CLEAR' });
      expect(state.payments).toHaveLength(0);
      expect(state.totalReceived).toBe(2); // totalReceived persists
      expect(state.filter).toBe('XLM'); // filter persists
      expect(state.isPaused).toBe(true); // pause state persists
    });
  });
});

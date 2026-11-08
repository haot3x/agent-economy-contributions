// SPDX-License-Identifier: CC0-1.0
// Author: Ted (@haot3x)
package proofintegration

import (
	"bytes"
	"context"
	"encoding/json"
	"math/big"
	"os/exec"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/consensus/beacon"
	"github.com/ethereum/go-ethereum/consensus/ethash"
	"github.com/ethereum/go-ethereum/core"
	"github.com/ethereum/go-ethereum/core/logindex/logquery"
	"github.com/ethereum/go-ethereum/core/rawdb"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/params"
)

// This fixture emits synthetic three-byte records (kind, wallet, amount).
// It tests proof-to-consumer integration, not ERC-20 or ERC-8004 ABI decoding.
var emitter = common.HexToAddress("0x1000000000000000000000000000000083040001")

type chainView struct{ *core.BlockChain }

func (v chainView) HeadNumber() uint64            { return v.CurrentBlock().Number.Uint64() }
func (v chainView) Header(n uint64) *types.Header { return v.GetHeaderByNumber(n) }
func (v chainView) Body(n uint64) *types.Body     { return v.GetBody(v.Header(n).Hash()) }
func (v chainView) RawReceipts(n uint64) types.Receipts {
	return v.GetRawReceipts(v.Header(n).Hash(), n)
}

// proverBackend supplies the public methods expected by logquery.NewMatcher.
type proverBackend struct{ *core.BlockChain }

func (b proverBackend) ChainConfig() *params.ChainConfig { return b.Config() }

func incomeChain(t *testing.T) *core.BlockChain {
	t.Helper()
	key, err := crypto.HexToECDSA("b71c71a67e1177ad4e901695e1b4b9ee17ae16c6668d313eac2f96dbcda3f291")
	if err != nil {
		t.Fatal(err)
	}
	cfg := *params.MergedTestChainConfig
	cfg.AmsterdamTime, cfg.EIP8304Time = new(uint64), new(uint64)
	alloc := core.SystemContractAllocs()
	alloc[params.IndexContractAddress] = types.Account{Nonce: 1, Code: params.IndexContractCode}
	if _, exists := alloc[emitter]; exists {
		t.Fatal("fixture emitter would overwrite a system contract")
	}
	// CALLDATACOPY(0, 0, size); LOG0(0, size); STOP.
	alloc[emitter] = types.Account{Code: common.FromHex("365f5f37365fa000")}
	alloc[crypto.PubkeyToAddress(key.PublicKey)] = types.Account{Balance: new(big.Int).Lsh(big.NewInt(1), 100)}
	genesis := &core.Genesis{Config: &cfg, Alloc: alloc}
	engine := beacon.New(ethash.NewFaker())
	chain, err := core.NewBlockChain(rawdb.NewMemoryDatabase(), genesis, engine, &core.BlockChainConfig{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(chain.Stop)
	// Opening wallet A is independently known. A=1, B=2; kind 0=receipt,
	// kind 1=wallet change. Correct attribution is 7+13+5, not 50+13+5.
	events := [][][]byte{
		{{0, 1, 7}, {0, 2, 50}, {1, 2, 0}, {0, 1, 11}, {0, 2, 13}},
		{{0, 2, 5}},
		nil, // publish the last queried block's index root
	}
	var nonce uint64
	db, blocks, _ := core.GenerateChainWithGenesis(genesis, engine, len(events), func(i int, g *core.BlockGen) {
		for _, payload := range events[i] {
			tx, err := types.SignNewTx(key, types.LatestSigner(&cfg), &types.LegacyTx{
				Nonce: nonce, To: &emitter, Gas: 100000, Data: payload,
				GasPrice: new(big.Int).Add(g.BaseFee(), common.Big1),
			})
			if err != nil {
				t.Fatal(err)
			}
			nonce++
			g.AddTx(tx)
		}
	})
	t.Cleanup(func() { db.Close() })
	if _, err := chain.InsertChain(blocks); err != nil {
		t.Fatal(err)
	}
	chain.SyncLogIndex()
	return chain
}

type event struct {
	Block  uint64 `json:"block"`
	Log    uint   `json:"log"`
	Kind   string `json:"kind"`
	Wallet string `json:"wallet"`
	Amount uint8  `json:"amount,omitempty"`
}
type query struct {
	First  uint64 `json:"first"`
	Last   uint64 `json:"last"`
	Limit  uint64 `json:"limit"`
	Latest bool   `json:"latest"`
}
type page struct {
	Requested query   `json:"requested"`
	Effective query   `json:"effective"`
	Events    []event `json:"events"`
	Complete  bool    `json:"complete"` // expected consumer state, not a wire proof flag
}

func request(t *testing.T, first, last, limit uint64) logquery.FilterQuery {
	t.Helper()
	pattern, err := logquery.NewLegacyMatcher([]common.Address{emitter}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return logquery.FilterQuery{Pattern: pattern, FirstBlock: first, LastBlock: last, Limit: limit, LimitLatest: true}
}

func provenPage(t *testing.T, bc *core.BlockChain, req logquery.FilterQuery) (*logquery.QueryProof, *logquery.Result) {
	t.Helper()
	matcher := logquery.NewMatcher(bc.LogIndex(), proverBackend{bc})
	_, _, proof, err := matcher.GetMatches(context.Background(), chainView{bc}, req, true)
	if err != nil {
		t.Fatal(err)
	}
	// Cross the actual proof serialization boundary. Unverified served logs are
	// deliberately not inputs to the consumer; Verify reconstructs them.
	blob, err := json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}
	var decoded logquery.QueryProof
	if err := json.Unmarshal(blob, &decoded); err != nil {
		t.Fatal(err)
	}
	result, err := decoded.Verify(bc.CurrentBlock(), req, logquery.DefaultVerifyOptions(bc.Config()))
	if err != nil {
		t.Fatal(err)
	}
	return &decoded, result
}

func normalize(t *testing.T, req logquery.FilterQuery, res *logquery.Result, complete bool) page {
	t.Helper()
	if req.Cursor != nil {
		t.Fatal("cursor pages need additional block-coverage logic")
	}
	p := page{
		Requested: query{req.FirstBlock, req.LastBlock, req.Limit, true},
		Effective: query{res.FirstBlock, res.LastBlock, req.Limit, true},
		Events:    make([]event, 0, len(res.Logs)), Complete: complete,
	}
	for _, log := range res.Logs {
		if log.Address != emitter || len(log.Topics) != 0 || len(log.Data) != 3 || log.Data[0] > 1 || log.Data[1] < 1 || log.Data[1] > 2 {
			t.Fatal("unexpected fixture event")
		}
		e := event{Block: log.BlockNumber, Log: log.Index, Kind: "receipt", Wallet: string(rune('A' + log.Data[1] - 1)), Amount: log.Data[2]}
		if log.Data[0] == 1 {
			e.Kind = "wallet-change"
		}
		p.Events = append(p.Events, e)
	}
	return p
}

func consume(t *testing.T, bc *core.BlockChain, pages ...page) {
	t.Helper()
	input, err := json.Marshal(struct {
		Head  string `json:"head"`
		Pages []page `json:"pages"`
	}{bc.CurrentBlock().Hash().Hex(), pages})
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("python3", "-B", "consume_verified.py")
	cmd.Stdin = bytes.NewReader(input)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("existing Python consumer: %v\n%s", err, output)
	}
	t.Log(string(output))
}

func TestVerifiedPagesFeedExistingIncomeConsumer(t *testing.T) {
	bc := incomeChain(t)
	all := request(t, 1, 2, 20)
	_, full := provenPage(t, bc, all)
	if len(full.Logs) != 6 {
		t.Fatalf("want six verified events, got %d", len(full.Logs))
	}
	t.Run("complete", func(t *testing.T) { consume(t, bc, normalize(t, all, full, true)) })
	t.Run("latest-first-overlap-and-retry", func(t *testing.T) {
		req := request(t, 2, 2, 20)
		_, recent := provenPage(t, bc, req)
		p := normalize(t, all, full, true)
		consume(t, bc, normalize(t, req, recent, false), p, p)
	})
	t.Run("capped-page-needs-boundary-refill", func(t *testing.T) {
		capReq, recentReq, refillReq := request(t, 1, 2, 3), request(t, 2, 2, 20), request(t, 1, 1, 20)
		_, capped := provenPage(t, bc, capReq)
		if len(capped.Logs) != 3 {
			t.Fatalf("pinned verifier must exercise a capped page, got %d", len(capped.Logs))
		}
		_, recent := provenPage(t, bc, recentReq)
		_, refill := provenPage(t, bc, refillReq)
		consume(t, bc, normalize(t, capReq, capped, false), normalize(t, recentReq, recent, false), normalize(t, refillReq, refill, true))
	})
}

func TestInvalidProofsNeverReachIncomeConsumer(t *testing.T) {
	bc := incomeChain(t)
	req := request(t, 1, 2, 20)
	for _, kind := range []string{"wrong-trusted-header", "corrupt-receipt-proof", "omitted-receipt", "wrong-query"} {
		t.Run(kind, func(t *testing.T) {
			proof, _ := provenPage(t, bc, req)
			trusted, expected := types.CopyHeader(bc.CurrentBlock()), req
			switch kind {
			case "wrong-trusted-header":
				trusted.Root[0] ^= 1
			case "wrong-query":
				expected.Limit = 19
			case "corrupt-receipt-proof":
				mutated := false
				for i := range proof.TableQueryProofs {
					for j := range proof.TableQueryProofs[i].BlockResults {
						r := &proof.TableQueryProofs[i].BlockResults[j]
						if len(r.ReceiptsProof) > 0 && len(r.ReceiptsProof[0]) > 0 {
							r.ReceiptsProof[0][0] ^= 1
							mutated = true
							break
						}
					}
					if mutated {
						break
					}
				}
				if !mutated {
					t.Fatal("no receipt proof to corrupt")
				}
			case "omitted-receipt":
				mutated := false
				for i := range proof.TableQueryProofs {
					for j := range proof.TableQueryProofs[i].BlockResults {
						r := &proof.TableQueryProofs[i].BlockResults[j]
						if r.Header.Number.Uint64() == 1 && len(r.ProvenReceipts) == 5 {
							r.ProvenReceipts = r.ProvenReceipts[:4]
							mutated = true
							break
						}
					}
				}
				if !mutated {
					t.Fatal("did not find the five-receipt block")
				}
			}
			if _, err := proof.Verify(trusted, expected, logquery.DefaultVerifyOptions(bc.Config())); err == nil {
				t.Fatal("invalid proof reached the accounting boundary")
			} else {
				t.Log(err)
			}
		})
	}
}

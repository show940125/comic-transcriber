import unittest
from metrics import distance,evaluate,normalize,parity

class MetricsTest(unittest.TestCase):
    def test_normalization_does_not_erase_negation_or_punctuation(self):
        self.assertEqual(normalize('Ａ　日\n本'),'A日本')
        self.assertNotEqual(normalize('ない。'),normalize('ある。'))
        self.assertEqual(distance('今日は','今日は！'),1)
    def test_missing_references_are_not_scored_and_blank_errors_are_counted(self):
        records=[{'id':'r','dataset':'real','section':'body'},{'id':'s','dataset':'synthetic','reference':'あい'},{'id':'b','dataset':'blank','reference':''}]
        result=evaluate(records,[{'id':'r','source':'推測'},{'id':'s','source':'あ'},{'id':'b','source':'字'}],{'rows':[]})
        self.assertEqual(result['groups']['real']['scored'],0)
        self.assertEqual(result['groups']['synthetic']['cer'],.5)
        self.assertEqual(result['groups']['blank']['blankHallucinations'],1)
    def test_eos_difference_is_not_token_parity(self):
        a=[{'id':'r','source':'字','tokens':[2,5],'steps':[{'token':5},{'token':3}],'ended':True}]
        b=[{'id':'r','source':'字','tokens':[2,5],'steps':[{'token':5}],'ended':False}]
        self.assertFalse(parity(a,b)['identical'])
    def test_partial_output_cannot_claim_full_parity(self):
        a=[{'id':'r','source':'字','tokens':[2,5],'ended':True}]
        self.assertFalse(parity(a,[])['identical'])

if __name__=='__main__':unittest.main()

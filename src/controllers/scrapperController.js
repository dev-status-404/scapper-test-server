
import scrapperService from '../services/scrapperService.js';
import Lead from '../models/lead.model.js';
import userLeadService from '../services/userLeadService.js';

const splitName = (fullName) => {
  if (!fullName || typeof fullName !== 'string') {
    return {
      first_name: null,
      last_name: null,
    };
  }

  const parts = fullName.trim().split(' ');
  return {
    first_name: parts[0] || null,
    last_name: parts.slice(1).join(' ') || null,
  };
};

const uniqueValues = (values = []) => [...new Set(values.filter(Boolean))];

const extractCandidateContacts = (candidate = {}) => {
  const emails = candidate.contacts
    ?.filter(contact => contact.type === 'email')
    ?.map(contact => contact.value) || [];

  const phone_numbers = candidate.contacts
    ?.filter(contact => contact.type === 'phone')
    ?.map(contact => contact.value) || [];

  return {
    emails: uniqueValues(emails),
    phone_numbers: uniqueValues(phone_numbers),
  };
};

const buildSignalHireMessage = (candidate, requestId) => {
  const currentExperience = candidate.experience?.find(exp => exp.current) || candidate.experience?.[0];
  const skills = candidate.skills?.join(', ') || '';

  return {
    currentExperience,
    message: `
SignalHire Enhanced Profile Scraped

Personal Information:
Name: ${candidate.fullName || 'N/A'}
Location: ${candidate.locations?.[0]?.name || 'N/A'}
Gender: ${candidate.gender || 'N/A'}
Experience Years: ${candidate.experienceYears || 'N/A'}

Professional Information:
Current Position: ${currentExperience?.position || 'N/A'}
Current Company: ${currentExperience?.company || 'N/A'}
Industry: ${currentExperience?.industry || 'N/A'}
Headline: ${candidate.headLine || 'N/A'}

Skills: ${skills || 'N/A'}

Summary: ${candidate.summary || 'N/A'}

Education: ${candidate.education?.map(edu => `${edu.school || 'N/A'} - ${edu.degree || 'N/A'}`).join('\n') || 'N/A'}

Experience:
${candidate.experience?.slice(0, 3).map(exp => 
  `${exp.position || 'N/A'} at ${exp.company || 'N/A'} (${exp.started ? new Date(exp.started).getFullYear() : 'N/A'} - ${exp.current ? 'Present' : (exp.ended ? new Date(exp.ended).getFullYear() : 'N/A')})`
).join('\n') || 'N/A'}

Social Media Profiles:
${candidate.social?.map(social => `${social.type.toUpperCase()}: ${social.link}`).join('\n') || 'N/A'}

Languages: ${candidate.language?.map(lang => lang.name).join(', ') || 'N/A'}

Honors & Awards: ${candidate.honorAward?.map(award => award.name).join(', ') || 'N/A'}

Request ID: ${requestId || 'N/A'}
    `.trim(),
  };
};

const scrapeInstagramDetail = async (req, res) => {
  try {
    const { profileUrl, user_id, folder_id } = req.body;
    const response = await scrapperService.scrapeInstagramProfile({profileUrl, user_id, folder_id});
    return res.status(response.code).json(
      {
        code: response.code,
        success: response.success,
        message: response.message,
        data: response.data,
      }
    );
  } catch (error) {
    return res.status(400).json(
      {
        code: 400,
        success: false,
        message: error.message,
        error: error,
      }
    );
  }
};

const scrapeLinkedInProfile = async (req, res) => {
  try {
    const { profile_url, user_id, folder_id } = req.body;
    const response = await scrapperService.scrapeLinkedInProfile({ profileUrl: profile_url, user_id, folder_id, res });
    return res.status(response.code).json(
      {
        code: response.code,
        success: response.success,
        message: response.message,
        data: response.data,
      }
    );
  } catch (error) {
    return res.status(400).json(
      {
        code: 400,
        success: false,
        message: error.message,
      }
    );
  }
};

const signalHireCallback = async (req, res) => {
  try {
    console.log('SignalHire callback received:', req.body);
    
    // Handle different response structures
    const candidates = req.body.candidates || (req.body[0]?.candidate ? [req.body[0].candidate] : []);
    const requestId = req.body.requestId || req.body[0]?.requestId;
    const status = req.body.status || req.body[0]?.status;
    
    console.log('Processing candidates:', candidates.length);
    
    if ((status === 'completed' || status === 'success') && candidates && candidates.length > 0) {
      // Process the scraped candidate data
      for (const candidate of candidates) {
        try {
          console.log('Processing candidate:', candidate.fullName || candidate.uid);
          
          // Extract emails from contacts array
          const emails = candidate.contacts
            ?.filter(contact => contact.type === 'email')
            ?.map(contact => contact.value) || [];

          // Extract phone numbers from contacts array
          const phone_numbers = candidate.contacts
            ?.filter(contact => contact.type === 'phone')
            ?.map(contact => contact.value) || [];

          // Get current position from experience array
          const currentExperience = candidate.experience?.find(exp => exp.current) || candidate.experience?.[0];
          
          // Extract skills as comma-separated string
          const skills = candidate.skills?.join(', ') || '';

          // Create comprehensive message with all available information
          const message = `
SignalHire Enhanced Profile Scraped

Personal Information:
Name: ${candidate.fullName || 'N/A'}
Location: ${candidate.locations?.[0]?.name || 'N/A'}
Gender: ${candidate.gender || 'N/A'}
Experience Years: ${candidate.experienceYears || 'N/A'}

Professional Information:
Current Position: ${currentExperience?.position || 'N/A'}
Current Company: ${currentExperience?.company || 'N/A'}
Industry: ${currentExperience?.industry || 'N/A'}
Headline: ${candidate.headLine || 'N/A'}

Skills: ${skills || 'N/A'}

Summary: ${candidate.summary || 'N/A'}

Education: ${candidate.education?.map(edu => `${edu.school || 'N/A'} - ${edu.degree || 'N/A'}`).join('\n') || 'N/A'}

Experience:
${candidate.experience?.slice(0, 3).map(exp => 
  `${exp.position || 'N/A'} at ${exp.company || 'N/A'} (${exp.started ? new Date(exp.started).getFullYear() : 'N/A'} - ${exp.current ? 'Present' : (exp.ended ? new Date(exp.ended).getFullYear() : 'N/A')})`
).join('\n') || 'N/A'}

Social Media Profiles:
${candidate.social?.map(social => `${social.type.toUpperCase()}: ${social.link}`).join('\n') || 'N/A'}

Languages: ${candidate.language?.map(lang => lang.name).join(', ') || 'N/A'}

Honors & Awards: ${candidate.honorAward?.map(award => award.name).join(', ') || 'N/A'}

Request ID: ${requestId || 'N/A'}
          `.trim();

          // Structure lead data according to your schema
          // const leadData = {
          //   first_name: candidate.fullName?.split(' ')[0] || null,
          //   last_name: candidate.fullName?.split(' ').slice(1).join(' ') || null,
          //   emails: emails.length > 0 ? emails : [],
          //   phone_numbers: phone_numbers.length > 0 ? phone_numbers : [],
          //   company: currentExperience?.company || null,
          //   job_title: currentExperience?.position || null,
          //   message: message,
          //   user_id: req.query.user_id, // You might need to store this separately or get it from requestId
          //   folder_id: req.query.folder_id ?? null, // You might need to store this separately or get it from requestId
          //   scrape_id: req.query.scrape_id,
          //   type: "LINKEDIN", // Set type as LinkedIn since this is from SignalHire LinkedIn scraping
          // };

            const leadData = {
            first_name: candidate.fullName?.split(' ')[0] || null,
            last_name: candidate.fullName?.split(' ').slice(1).join(' ') || null,
            emails: emails.length > 0 ? emails : [],
            phone_numbers: phone_numbers.length > 0 ? phone_numbers : [],
            location: candidate.locations?.[0]?.name || null,
            gender: candidate.gender || null,
            experience_years: Number.isFinite(candidate.experienceYears)
              ? candidate.experienceYears
              : null,
            company: currentExperience?.company || null,
            job_title: currentExperience?.position || null,
            industry: currentExperience?.industry || null,
            headline: candidate.headLine || null,
            skills: Array.isArray(candidate.skills)
              ? candidate.skills.filter(Boolean)
              : [],
            summary: candidate.summary || null,
            education: candidate.education
              ?.map(edu => `${edu.school || 'N/A'} - ${edu.degree || 'N/A'}`)
              ?.filter(Boolean) || [],
            experiences: candidate.experience
              ?.map(exp => ({
                position: exp?.position || null,
                company: exp?.company || null,
                industry: exp?.industry || null,
                started: exp?.started ? new Date(exp.started) : null,
                ended: exp?.ended ? new Date(exp.ended) : null,
                current: Boolean(exp?.current),
              }))
              ?.filter(exp => exp.position || exp.company || exp.industry) || [],
            social_profiles: candidate.social
              ?.map(social => ({
                type: social?.type || null,
                link: social?.link || null,
              }))
              ?.filter(social => social.type || social.link) || [],
            languages: candidate.language
              ?.map(lang => lang?.name)
              ?.filter(Boolean) || [],
            honors_awards: candidate.honorAward
              ?.map(award => award?.name)
              ?.filter(Boolean) || [],
            request_id: requestId || null,
            message: "",
            user_id: req.query.user_id, // You might need to store this separately or get it from requestId
            folder_id: req.query.folder_id ?? null, // You might need to store this separately or get it from requestId
            scrape_id: req.query.scrape_id,
            type: "LINKEDIN", // Set type as LinkedIn since this is from SignalHire LinkedIn scraping
          };

          // Save the lead with enhanced information (dedup-aware via UserLead)
          const { lead } = await userLeadService.resolveOrCreateLead(
            leadData,
            {
              user_id: req.query.user_id,
              folder_id: req.query.folder_id ?? null,
              type: "LINKEDIN",
            },
          );
          console.log('Enhanced lead created/reused:', lead._id);
          
          console.log(`Enhanced lead created for: ${candidate.fullName} with ${emails.length} emails and ${phone_numbers.length} phone numbers`);
        } catch (error) {
          console.error('Error creating enhanced lead from SignalHire callback:', error);
        }
      }
    }
    
    return res.status(200).json({
      code: 200,
      success: true,
      message: 'Enhanced callback processed successfully',
    });
  } catch (error) {
    console.error('SignalHire callback error:', error);
    return res.status(500).json({
      code: 500,
      success: false,
      message: 'Failed to process enhanced callback',
    });
  }
};

const signalHireInstagramCallback = async (req, res) => {
  try {
    console.log('SignalHire Instagram callback received:', req.body);

    const candidates = req.body.candidates || (req.body[0]?.candidate ? [req.body[0].candidate] : []);
    const requestId = req.body.requestId || req.body[0]?.requestId;
    const status = req.body.status || req.body[0]?.status;
    const leadId = req.query.lead_id;
    const scrapeId = req.query.scrape_id;

    if ((status !== 'completed' && status !== 'success') || !candidates.length) {
      return res.status(200).json({
        code: 200,
        success: true,
        message: 'Instagram callback received without completed candidates',
      });
    }

    const existingLead = leadId
      ? await Lead.findById(leadId)
      : await Lead.findOne({ scrape_id: scrapeId, user_id: req.query.user_id ?? undefined }).sort({ createdAt: -1 });

    if (!existingLead) {
      return res.status(200).json({
        code: 200,
        success: false,
        message: 'No existing Instagram lead found for SignalHire callback',
      });
    }

    const candidate = candidates[0];
    const { first_name, last_name } = splitName(candidate.fullName);
    const { emails, phone_numbers } = extractCandidateContacts(candidate);
    const { currentExperience, message } = buildSignalHireMessage(candidate, requestId);

    existingLead.first_name = first_name || existingLead.first_name;
    existingLead.last_name = last_name || existingLead.last_name;
    existingLead.full_name = candidate.fullName || existingLead.full_name;
    existingLead.emails = uniqueValues([...(existingLead.emails || []), ...emails]);
    existingLead.phone_numbers = uniqueValues([...(existingLead.phone_numbers || []), ...phone_numbers]);
    existingLead.company = currentExperience?.company || existingLead.company;
    existingLead.job_title = currentExperience?.position || existingLead.job_title;
    existingLead.scrape_id = scrapeId || existingLead.scrape_id;
    existingLead.scrape_status = true;
    existingLead.message = [existingLead.message, message].filter(Boolean).join('\n\n');

    await existingLead.save();

    return res.status(200).json({
      code: 200,
      success: true,
      message: 'Instagram lead enriched successfully from SignalHire callback',
      data: {
        lead_id: existingLead._id,
      },
    });
  } catch (error) {
    console.error('SignalHire Instagram callback error:', error);
    return res.status(500).json({
      code: 500,
      success: false,
      message: 'Failed to process Instagram enrichment callback',
    });
  }
};

const scrapeInstagramProfileV2 = async (req, res) => {
  try {
    const { profileUrl, user_id, folder_id } = req.body;
    const response = await scrapperService.scrapeInstagramProfileV2({ profileUrl: profileUrl, user_id, folder_id });
    return res.status(response.code).json(
      {
        code: response.code,
        success: response.success,
        message: response.message,
        data: response.data,
      }
    );
  } catch (error) {
    return res.status(400).json(
      {
        code: 400,
        success: false,
        message: error.message,
      }
    );
  }
};


export const scrapperController = {
      scrapeInstagramDetail,
      scrapeLinkedInProfile,
      signalHireCallback,
  signalHireInstagramCallback,
      scrapeInstagramProfileV2,
  }
